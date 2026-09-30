"""Run with production Python on Linux; macOS verifies fail-closed only."""
import json
import os
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from unittest.mock import Mock, patch

ROOT = Path(os.environ.get("CONTACT_WORKER_PYTHON_ROOT", Path(__file__).resolve().parents[1]))

class SandboxTests(unittest.TestCase):
    def run_probe(self, code, *, limits="", before="", hardened=True, **kwargs):
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
            bootstrap += f"source=Path({str(source)!r}); scratch=Path({str(scratch)!r}); "
            bootstrap += before + "\n"
            if hardened:
                bootstrap += f"enter(source, scratch{limits}); "
            return subprocess.run([sys.executable, "-c", bootstrap + code],
                env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(ROOT), "SERVICE_SECRET": "canary"},
                capture_output=True, text=True, timeout=15, **kwargs)

    @contextmanager
    def signal_sentinel(self):
        sentinel = subprocess.Popen([sys.executable, '-u', '-c', """
import os,resource,signal,time,json
resource.setrlimit(resource.RLIMIT_NOFILE, (96,96))
for signum in (signal.SIGIO, signal.SIGUSR1):
    signal.signal(signum, lambda number, _: print(number, flush=True))
print(json.dumps([os.getuid(),os.getgid()]), flush=True)
while True: time.sleep(1)
"""], stdout=subprocess.PIPE, bufsize=0)
        try:
            self.assertEqual(json.loads(sentinel.stdout.readline()), [os.getuid(), os.getgid()])
            yield sentinel
        finally:
            sentinel.kill()
            sentinel.wait(timeout=5)
            sentinel.stdout.close()

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_foreign_prlimit_cannot_change_same_uid_sentinel(self):
        import resource
        for hardened in (False, True):
            with self.subTest(hardened=hardened), self.signal_sentinel() as sentinel:
                result = self.run_probe(f"""
import resource
try: resource.prlimit({sentinel.pid}, resource.RLIMIT_NOFILE, (64,64))
except PermissionError: assert {hardened!r}
else: assert not {hardened!r}, 'foreign limits changed'
# glibc getrlimit/setrlimit use prlimit64 with pid=0. Keep this runtime path working.
limits=resource.getrlimit(resource.RLIMIT_NOFILE)
assert resource.prlimit(0, resource.RLIMIT_NOFILE) == limits
resource.setrlimit(resource.RLIMIT_NOFILE, limits)
resource.prlimit(0, resource.RLIMIT_NOFILE, limits)
pid=os.fork()
if pid==0:
    assert resource.prlimit(0, resource.RLIMIT_NOFILE) == limits
    os._exit(0)
assert os.waitpid(pid,0)[1] == 0
""", hardened=hardened)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(resource.prlimit(sentinel.pid, resource.RLIMIT_NOFILE),
                                 (96,96) if hardened else (64,64))
                self.assertIsNone(sentinel.poll())
                self.assertFalse(select.select([sentinel.stdout], [], [], 0.1)[0])

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_async_signals_cannot_reach_same_uid_sentinel(self):
        import signal
        # Owners are set on pipes created AFTER sealing. For ioctl/enable tests,
        # a trusted fixture maps a socketpair/pipe onto stdio BEFORE closing extra FDs.
        # Every attack has an unsealed positive control that must deliver a signal.
        cases = ('owner', 'owner_ex', 'setsig', 'setfl_async', 'fiosetown', 'siocspgrp', 'fioasync')
        for case in cases:
            for high_bits in (0, 1 << 32):
                for hardened in (False, True):
                    with self.subTest(case=case, high_bits=high_bits, hardened=hardened), self.signal_sentinel() as sentinel:
                        before = ''
                        if case not in ('owner', 'owner_ex'):
                            before = "import fcntl,socket; "
                            if case in ('fiosetown', 'siocspgrp', 'fioasync'):
                                before += "a,b=socket.socketpair(); os.dup2(a.fileno(),0); os.dup2(b.fileno(),1); a.close(); b.close(); "
                            else:
                                before += "a,b=os.pipe(); os.dup2(a,0); os.dup2(b,1); os.close(a); os.close(b); "
                            if case in ('setsig', 'setfl_async', 'fioasync'):
                                before += f"fcntl.fcntl(0,fcntl.F_SETOWN,{sentinel.pid}); "
                            if case == 'setsig':
                                before += "fcntl.fcntl(0,fcntl.F_SETFL,os.O_ASYNC); "
                        code = f"""
import ctypes,fcntl,signal,struct
libc=ctypes.CDLL(None,use_errno=True)
libc.syscall.restype=ctypes.c_long
sec=ctypes.CDLL('libseccomp.so.2')
sec.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]
r,w=os.pipe() if {case!r} in ('owner','owner_ex') else (0,1)
case={case!r}
if case=='owner': cmd,arg=8,ctypes.c_int({sentinel.pid})
elif case=='owner_ex':
    owner=ctypes.create_string_buffer(struct.pack('ii',1,{sentinel.pid})) # F_OWNER_PID
    cmd,arg=15,ctypes.byref(owner)
elif case=='setsig': cmd,arg=10,ctypes.c_int(signal.SIGUSR1)
elif case=='setfl_async': cmd,arg=4,ctypes.c_int(os.O_ASYNC)
else:
    value=ctypes.c_int(1 if case=='fioasync' else {sentinel.pid})
    cmd={{'fiosetown':0x8901,'siocspgrp':0x8902,'fioasync':0x5452}}[case]
    arg=ctypes.byref(value)
name='ioctl' if case in ('fiosetown','siocspgrp','fioasync') else 'fcntl'
nr=sec.seccomp_syscall_resolve_name(name.encode())
ctypes.set_errno(0)
result=libc.syscall(nr,r,ctypes.c_ulonglong(cmd | {high_bits}),arg)
if {hardened!r}:
    assert result == -1 and ctypes.get_errno() == 1, (case,result,ctypes.get_errno())
else:
    assert result == 0, (case,result,ctypes.get_errno())
    if case in ('owner','owner_ex','fiosetown','siocspgrp'):
        fcntl.fcntl(r,fcntl.F_SETFL,os.O_ASYNC)
# A pre-enabled fixture for F_SETSIG must not generate the default SIGIO after
# denial: stop here; other negative cases write and prove no signal delivery.
if {hardened!r} and case=='setsig': fcntl.fcntl(r,fcntl.F_SETFL,0)
else: os.write(w,b'x')
# Ordinary descriptor reads and nonblocking operation remain available.
fcntl.fcntl(r,fcntl.F_GETFD)
fcntl.fcntl(r,fcntl.F_GETFL)
if case!='setsig': fcntl.fcntl(r,fcntl.F_SETFL,os.O_NONBLOCK)
"""
                        result = self.run_probe(code, before=before, hardened=hardened)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIsNone(sentinel.poll())
                        ready = select.select([sentinel.stdout], [], [], 0.1 if hardened else 2)[0]
                        if hardened:
                            self.assertFalse(ready, 'async signal escaped')
                        else:
                            self.assertTrue(ready, 'positive control did not deliver')
                            expected = signal.SIGUSR1 if case == 'setsig' else signal.SIGIO
                            self.assertEqual(int(sentinel.stdout.readline()), expected)

    def test_seccomp_policy_blocks_process_controls_and_keeps_runtime_fd_operations(self):
        # Inspect the actual ctypes/libseccomp boundary without installing Linux
        # filters on the test runner. Real kernel effects have separate controls above.
        import ctypes
        from contact_worker import sandbox
        names, rules = [], []
        def resolve(name):
            if name not in names: names.append(name)
            return names.index(name)
        def add(_ctx, action, number, count, pointer):
            comparisons = ctypes.cast(pointer, ctypes.POINTER(sandbox.Compare))
            rules.append((names[number].decode(), action, [
                (comparisons[i].arg, comparisons[i].op, comparisons[i].datum_a, comparisons[i].datum_b)
                for i in range(count)]))
            return 0
        lib = Mock()
        lib.seccomp_init.return_value = 1
        lib.seccomp_syscall_resolve_name.side_effect = resolve
        lib.seccomp_rule_add_array.side_effect = add
        lib.seccomp_load.return_value = 0
        with patch.object(sandbox.C, 'CDLL', return_value=lib):
            sandbox._seccomp()
        def denied(name, *args):
            def matches(c):
                arg, op, a, b = c
                if op == 1: return args[arg] != a  # SCMP_CMP_NE
                if op == 4: return args[arg] == a  # SCMP_CMP_EQ
                if op == 7: return args[arg] & a == b  # SCMP_CMP_MASKED_EQ
                self.fail(f'unhandled comparison {op}')
            return any(n == name and action == 0x50001 and all(map(matches, cs))
                       for n, action, cs in rules)
        self.assertTrue(denied('prlimit64', os.getppid(), 7, 1, 0))
        self.assertFalse(denied('prlimit64', 0, 7, 0, 1))
        self.assertFalse(denied('prlimit64', 0, 7, 1, 0))
        for high in (0, 1 << 32):
            for command in (8, 10, 15):
                self.assertTrue(denied('fcntl', 0, high | command, 1), command)
            self.assertTrue(denied('fcntl', 0, high | 4, 0x2000))  # O_ASYNC
            for request in (0x8901, 0x8902, 0x5452):
                self.assertTrue(denied('ioctl', 0, high | request, 1), request)
        for command, arg in ((1,0), (2,1), (3,0), (4,0x800), (9,0), (16,1)):
            self.assertFalse(denied('fcntl', 0, command, arg), command)
        self.assertFalse(denied('ioctl', 0, 0x541b, 1))  # FIONREAD

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
import resource
assert resource.getrlimit(resource.RLIMIT_NPROC) == (64, 64)
(scratch / 'ok').write_text('scratch')
runtime_files = [Path('/dev/urandom')]
mime_types = Path('/etc/mime.types')
if mime_types.exists(): runtime_files.append(mime_types)
for path in runtime_files:
    with path.open('rb') as stream: stream.read(1)
    # Check write access without writing or truncating a runtime file.
    try: fd = os.open(path, os.O_WRONLY)
    except PermissionError: pass
    else:
        os.close(fd)
        raise AssertionError('runtime file writable: ' + str(path))
for path in [source.parent / 'sibling.pdf', source.parent / 'database.sqlite', source.parent / 'service.env', Path('/proc/self/environ'), Path('/etc/passwd'), Path('/data/salestools.sqlite')]:
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
