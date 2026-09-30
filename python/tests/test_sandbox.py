"""Run with production Python on Linux; macOS verifies fail-closed only."""
import json
import os
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(os.environ.get("CONTACT_WORKER_PYTHON_ROOT", Path(__file__).resolve().parents[1]))

class SandboxTests(unittest.TestCase):
    def run_probe(self, code, *, limits="", **kwargs):
        with tempfile.TemporaryDirectory(prefix="sandbox-probe-") as directory:
            root = Path(directory)
            source = root / "current.pdf"
            source.write_text("current")
            (root / "sibling.pdf").write_text("tenant-secret")
            (root / "database.sqlite").write_text("database-secret")
            (root / "service.env").write_text("service-secret")
            scratch = root / "scratch"
            scratch.mkdir()
            bootstrap = "from contact_worker.sandbox import enter; from pathlib import Path; import os,sys,json; "
            bootstrap += f"source=Path({str(source)!r}); scratch=Path({str(scratch)!r}); enter(source, scratch{limits}); "
            return subprocess.run([sys.executable, "-c", bootstrap + code],
                env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(ROOT), "SERVICE_SECRET": "canary"},
                capture_output=True, text=True, timeout=15, **kwargs)

    def test_platform_is_fail_closed(self):
        result = self.run_probe("print('UNSEALED')")
        if sys.platform != "linux":
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SANDBOX_UNAVAILABLE", result.stderr)
            self.assertNotIn("UNSEALED", result.stdout)
        else:
            self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_filesystem_and_secrets_are_sealed(self):
        result = self.run_probe("""
assert source.read_text() == 'current'
assert 'SERVICE_SECRET' not in os.environ
(scratch / 'ok').write_text('scratch')
for path in [source.parent / 'sibling.pdf', source.parent / 'database.sqlite', source.parent / 'service.env', Path('/proc/self/environ'), Path('/data/salestools.sqlite')]:
    try: path.read_bytes()
    except PermissionError: pass
    except FileNotFoundError:
        assert str(path).startswith('/data/')
    else: raise AssertionError('read permitted: ' + str(path))
for action in [lambda: source.write_text('overwritten'), lambda: os.truncate(source, 0), lambda: list(source.parent.iterdir())]:
    try: action()
    except PermissionError: pass
    else: raise AssertionError('write/truncate/list permitted')
(scratch / 'escape').symlink_to(source.parent / 'sibling.pdf')
try: (scratch / 'escape').read_bytes()
except PermissionError: pass
else: raise AssertionError('symlink escape')
print('sealed')
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'sealed')

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_syscalls_and_descendants_remain_sealed(self):
        result = self.run_probe("""
import ctypes, socket
libc=ctypes.CDLL(None, use_errno=True)
sec=ctypes.CDLL('libseccomp.so.2')
sec.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]
for name in ['socket','connect','ptrace','process_vm_readv','process_vm_writev','pidfd_getfd','io_uring_setup','io_uring_enter','io_uring_register','setsid','setpgid','unshare','setns']:
    nr=sec.seccomp_syscall_resolve_name(name.encode())
    ctypes.set_errno(0)
    assert libc.syscall(nr, -1, 0, 0, 0, 0, 0) == -1, name
    assert ctypes.get_errno() == 1, (name, ctypes.get_errno())
for family in [socket.AF_INET, socket.AF_UNIX, socket.AF_INET6]:
    try: socket.socket(family)
    except PermissionError: pass
    else: raise AssertionError('socket permitted')
pid=os.fork()
if pid == 0:
    try: (source.parent/'sibling.pdf').read_bytes()
    except PermissionError: os._exit(0)
    os._exit(1)
assert os.waitpid(pid,0)[1] == 0
print('sealed')
""")
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_queued_signals_cannot_reach_same_uid_sentinel(self):
        sentinel = subprocess.Popen([sys.executable, '-u', '-c',
            "import os,signal,time; signal.signal(signal.SIGUSR1, lambda *_: print('delivered',flush=True)); "
            "print('ready',flush=True); exec('while True: time.sleep(1)')"],
            stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(sentinel.stdout.readline().strip(), 'ready')
            for syscall in ('rt_sigqueueinfo', 'rt_tgsigqueueinfo'):
                code = f"""
import ctypes,os,signal,struct
libc=ctypes.CDLL(None,use_errno=True)
sec=ctypes.CDLL('libseccomp.so.2')
sec.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]
nr=sec.seccomp_syscall_resolve_name({syscall!r}.encode())
info=ctypes.create_string_buffer(128)
struct.pack_into('iii',info,0,signal.SIGUSR1,0,-1) # SI_QUEUE, with valid sender identity
struct.pack_into('iI',info,16,os.getpid(),os.getuid())
struct.pack_into('Q',info,24,1234)
args=({sentinel.pid},signal.SIGUSR1,ctypes.byref(info)) if {syscall!r}=='rt_sigqueueinfo' else ({sentinel.pid},{sentinel.pid},signal.SIGUSR1,ctypes.byref(info))
ctypes.set_errno(0)
result=libc.syscall(nr,*args)
"""
                # Positive control proves the same legitimate request reaches the sentinel.
                control = subprocess.run([sys.executable, '-c', code + "assert result == 0, ctypes.get_errno()"],
                                         capture_output=True, text=True, timeout=5)
                self.assertEqual(control.returncode, 0, control.stderr)
                self.assertTrue(select.select([sentinel.stdout], [], [], 2)[0])
                self.assertEqual(sentinel.stdout.readline().strip(), 'delivered')
                denied = self.run_probe(code + "assert result == -1 and ctypes.get_errno() == 1, (result,ctypes.get_errno())")
                self.assertEqual(denied.returncode, 0, denied.stderr)
                self.assertIsNone(sentinel.poll())
                self.assertFalse(select.select([sentinel.stdout], [], [], 0.1)[0], syscall)
        finally:
            sentinel.kill(); sentinel.wait(timeout=5); sentinel.stdout.close()

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_memory_file_and_cpu_limits(self):
        memory = self.run_probe("""
try: bytearray(512 * 1024**2)
except MemoryError: print('memory denied')
else: raise AssertionError('memory unbounded')
""", limits=", memory_bytes=128 * 1024**2")
        self.assertEqual(memory.returncode, 0, memory.stderr)
        self.assertIn('memory denied', memory.stdout)
        file = self.run_probe("""
import signal
signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
try:
    with (scratch/'huge').open('wb') as stream: stream.write(b'a'*(2*1024**2))
except OSError as e: assert e.errno == 27
else: raise AssertionError('file size unbounded')
""", limits=", max_file_bytes=1024**2")
        self.assertEqual(file.returncode, 0, file.stderr)
        cpu = self.run_probe("exec('while True: pass')", limits=", cpu_seconds=1")
        self.assertEqual(cpu.returncode, -9, cpu.stderr)

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_process_limit_cannot_be_raised(self):
        result = self.run_probe("""
import resource,time
try: resource.setrlimit(resource.RLIMIT_NPROC, (1000,1000))
except (ValueError,PermissionError): pass
else: raise AssertionError('process ceiling lifted')
children=[]
try:
    for _ in range(40):
        try: pid=os.fork()
        except BlockingIOError: break
        if pid==0: time.sleep(0.5); os._exit(0)
        children.append(pid)
    else: raise AssertionError('process limit ineffective (must run unprivileged)')
finally:
    for pid in children: os.waitpid(pid,0)
""")
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_extra_descriptors_are_closed(self):
        with tempfile.TemporaryFile() as stream:
            stream.write(b'fd-secret'); stream.flush()
            result = self.run_probe(f"""
try: os.read({stream.fileno()}, 100)
except OSError as e: assert e.errno == 9
else: raise AssertionError('inherited fd readable')
""", pass_fds=(stream.fileno(),))
        self.assertEqual(result.returncode, 0, result.stderr)

if __name__ == '__main__': unittest.main()
