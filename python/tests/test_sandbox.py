"""Run with production Python on Linux; macOS verifies fail-closed only."""
import json
import os
import select
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager, ExitStack
from unittest.mock import Mock, patch

ROOT = Path(os.environ.get("CONTACT_WORKER_PYTHON_ROOT", Path(__file__).resolve().parents[1]))

class SandboxTests(unittest.TestCase):
    def test_landlock_abi_masks_and_query_fail_closed(self):
        import ctypes
        from contact_worker import sandbox
        # The ctypes boundary is the only unavailable dependency on macOS.
        # Unsupported rights in either the ruleset or path grants must fail here.
        for abi, expected, scratch_rights in ((1, 8191, 4542), (2, 16383, 12734), (3, 32767, 29118)):
            with self.subTest(abi=abi), tempfile.TemporaryDirectory() as directory:
                source, scratch = Path(directory)/'input', Path(directory)/'scratch'
                source.write_text('current'); scratch.mkdir()
                handled, grants = [], []
                def syscall(number, *args):
                    if number == 444 and args[-1] == 1: return abi
                    if number == 444:
                        handled.append(ctypes.cast(args[0], ctypes.POINTER(sandbox.Ruleset)).contents.handled_access_fs)
                        return 100
                    if number == 445:
                        grants.append(ctypes.cast(args[2], ctypes.POINTER(sandbox.PathRule)).contents.allowed_access)
                    return 0
                libc = Mock(); libc.syscall.side_effect = syscall; libc.prctl.return_value = 0
                with ExitStack() as stack:
                    stack.enter_context(patch.object(sandbox.sys, 'platform', 'linux'))
                    stack.enter_context(patch.object(sandbox.platform, 'machine', return_value='x86_64'))
                    stack.enter_context(patch.object(sandbox, '_runtime_paths', return_value=[]))
                    stack.enter_context(patch.object(sandbox.C, 'CDLL', return_value=libc))
                    stack.enter_context(patch.object(sandbox.os, 'listdir', return_value=[]))
                    stack.enter_context(patch.object(sandbox.os, 'chdir'))
                    stack.enter_context(patch.dict(os.environ))
                    stack.enter_context(patch.object(sandbox.resource, 'setrlimit'))
                    stack.enter_context(patch.object(sandbox.os, 'close'))
                    stack.enter_context(patch.object(sandbox.os, 'open', return_value=9))
                    stack.enter_context(patch.object(sandbox.os, 'O_PATH', 0x200000, create=True))
                    seccomp = stack.enter_context(patch.object(sandbox, '_seccomp'))
                    try: sandbox.enter(source, scratch)
                    except sandbox.SandboxError as error: self.fail(f'ABI {abi} rejected: {error}')
                self.assertEqual(handled, [expected])
                self.assertEqual(grants[:2], [4, scratch_rights])
                self.assertTrue(all(rights & ~expected == 0 for rights in grants))
                seccomp.assert_called_once_with(abi)
        libc = Mock(); libc.syscall.return_value = -1
        try:
            with self.assertRaises(sandbox.SandboxError): sandbox._landlock_abi(libc)
        except AttributeError:
            self.fail('ABI query helper missing')
        libc.syscall.return_value = 0
        with self.assertRaises(sandbox.SandboxError): sandbox._landlock_abi(libc)

    def test_legacy_seccomp_truncation_policy_and_install_failure(self):
        import ctypes
        from contact_worker import sandbox
        for abi, machine in ((1,'x86_64'),(2,'x86_64'),(3,'x86_64'),(1,'aarch64'),(2,'aarch64'),(3,'aarch64')):
            with self.subTest(abi=abi, machine=machine):
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
                lib = Mock(); lib.seccomp_init.return_value = 1
                lib.seccomp_syscall_resolve_name.side_effect = resolve
                lib.seccomp_rule_add_array.side_effect = add; lib.seccomp_load.return_value = 0
                with patch.object(sandbox.C, 'CDLL', return_value=lib), patch.object(os, 'O_TRUNC', 512), patch.object(os, 'O_ACCMODE', 3), patch.object(sandbox.errno, 'ENOSYS', 38), patch.object(sandbox.platform, 'machine', return_value=machine):
                    try: sandbox._seccomp(abi)
                    except TypeError as error: self.fail(f'ABI-aware seccomp missing: {error}')
                def action(name, args):
                    for n, result, conditions in rules:
                        if n != name: continue
                        if all((args[arg] != a if op == 1 else args[arg] & a == b)
                               for arg, op, a, b in conditions): return result
                    return 0x7fff0000
                for name in ('truncate', 'ftruncate'):
                    self.assertEqual(action(name, [9, 0]), 0x50001 if abi < 3 else 0x7fff0000)
                self.assertEqual(action('openat2', [9, 0, 0, 24]), 0x50026 if abi < 3 else 0x7fff0000)
                # Linux flag literals: portable test runner flags differ on macOS.
                for name, index in (('open', 1), ('openat', 2)):
                    for mode in range(4):
                        args = [0, 0, 0, 0]; args[index] = 512 | 64 | mode
                        blocked = abi < 3 and mode in (0,3) and (name == 'openat' or machine == 'x86_64')
                        self.assertEqual(action(name, args), 0x50001 if blocked else 0x7fff0000)
                    args[index] = 0
                    self.assertEqual(action(name, args), 0x7fff0000)
                lib.seccomp_rule_add_array.side_effect = None
                lib.seccomp_rule_add_array.return_value = -22
                with patch.object(sandbox.C, 'CDLL', return_value=lib), self.assertRaises(sandbox.SandboxError):
                    sandbox._seccomp(abi)
                lib.seccomp_rule_add_array.return_value = 0
                lib.seccomp_load.return_value = -1
                with patch.object(sandbox.C, 'CDLL', return_value=lib), self.assertRaises(sandbox.SandboxError):
                    sandbox._seccomp(abi)
                if abi < 3:
                    lib.seccomp_load.return_value = 0
                    lib.seccomp_syscall_resolve_name.side_effect = lambda name: -1 if name == b'openat2' else resolve(name)
                    with patch.object(sandbox.C, 'CDLL', return_value=lib), self.assertRaises(sandbox.SandboxError):
                        sandbox._seccomp(abi)

    def run_probe(self, code, *, limits="", before="", hardened=True, preserve_contents=False, **kwargs):
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
            result = subprocess.run([sys.executable, "-c", bootstrap + code],
                env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(ROOT), "SERVICE_SECRET": "canary"},
                capture_output=True, text=True, timeout=15, **kwargs)
            if preserve_contents:
                self.assertEqual(source.read_bytes(), b'current')
                self.assertEqual((root/'sibling.pdf').read_bytes(), b'tenant-secret')
                self.assertEqual((scratch/'protected').read_bytes(), b'scratch-secret')
            return result

    @unittest.skipUnless(sys.platform == "linux", "real Linux kernel required")
    def test_abi1_compensation_preserves_input_and_scratch_bytes(self):
        # Real enforcement on this kernel with only the queried ABI changed;
        # a modern kernel passing this is not evidence of an actual ABI1 node.
        before = "(scratch/'protected').write_text('scratch-secret'); import contact_worker.sandbox as sandbox; sandbox._landlock_abi=lambda _:1; "
        result = self.run_probe("""
import ctypes,errno,platform
libc=ctypes.CDLL(None,use_errno=True); libc.syscall.restype=ctypes.c_long
sec=ctypes.CDLL('libseccomp.so.2'); sec.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]
def denied(name,*args,error=errno.EPERM):
    number=sec.seccomp_syscall_resolve_name(name.encode())
    assert number >= 0, (name,number)
    ctypes.set_errno(0)
    result=libc.syscall(number,*args)
    assert result == -1 and ctypes.get_errno() == error, (name,result,ctypes.get_errno())
class OpenHow(ctypes.Structure):
    _fields_=[('flags',ctypes.c_uint64),('mode',ctypes.c_uint64),('resolve',ctypes.c_uint64)]
opens=[('openat',2)]
if platform.machine()=='x86_64': opens.append(('open',1))
for path in (source,source.parent/'sibling.pdf',scratch/'protected'):
    encoded=ctypes.c_char_p(os.fsencode(path))
    denied('truncate',encoded,ctypes.c_longlong(0))
    for name,_ in opens:
        for mode in (os.O_RDONLY,os.O_ACCMODE):
            flags=os.O_TRUNC | mode
            args=(encoded,flags,0) if name=='open' else (-100,encoded,flags,0)
            denied(name,*args)
    how=OpenHow(os.O_RDONLY|os.O_TRUNC,0,0)
    denied('openat2',-100,encoded,ctypes.byref(how),ctypes.sizeof(how),error=errno.ENOSYS)
for path,mode in ((source,os.O_RDONLY),(scratch/'protected',os.O_RDWR)):
    fd=os.open(path,mode)
    try: denied('ftruncate',fd,ctypes.c_longlong(0))
    finally: os.close(fd)
for path in (source,source.parent/'sibling.pdf'):
    for mode in (os.O_WRONLY,os.O_RDWR):
        try: fd=os.open(path,mode|os.O_TRUNC)
        except PermissionError: pass
        else: os.close(fd); raise AssertionError('input writable')
try: (source.parent/'sibling.pdf').read_bytes()
except PermissionError: pass
else: raise AssertionError('sibling readable')
for mode in (os.O_WRONLY,os.O_RDWR):
    path=scratch/('ordinary-'+str(mode))
    fd=os.open(path,mode|os.O_CREAT|os.O_TRUNC,0o600)
    os.write(fd,b'allowed'); os.close(fd)
    assert path.read_bytes()==b'allowed'
    renamed=path.with_name(path.name+'-renamed'); path.rename(renamed)
(scratch/'nested').mkdir()
try: (scratch/'protected').rename(scratch/'nested'/'moved')
except OSError as error: assert error.errno in (errno.EXDEV,errno.EACCES)
else: raise AssertionError('ABI1 cross-directory rename allowed')
assert source.read_bytes()==b'current'
assert (scratch/'protected').read_bytes()==b'scratch-secret'
print('ABI1 policy sealed')
""", before=before, preserve_contents=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'ABI1 policy sealed')
        control = self.run_probe("fd=os.open(source,os.O_RDONLY|os.O_TRUNC); os.close(fd); assert source.read_bytes()==b''", hardened=False)
        self.assertEqual(control.returncode, 0, control.stderr)

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
            sandbox._seccomp(3)
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
    for _ in range(80):
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

class LegacyParsingTests(unittest.TestCase):
    """Collected by the existing full pytest gate; separate from 60s kernel smoke.

    Explicit production-image invocation: contact-sandbox-tests.py LegacyParsingTests -v.
    Mocking only the ABI query on a modern kernel verifies compatibility policy,
    not actual ABI1 kernel compatibility.
    """
    @unittest.skipUnless(sys.platform == 'linux', 'real Linux kernel and production parser required')
    def test_abi1_policy_hardened_pdf_and_png_have_source_blocks(self):
        import signal
        from PIL import Image, ImageDraw, ImageFont
        with tempfile.TemporaryDirectory(prefix='abi1-parse-') as directory:
            root = Path(directory)
            pdf_fixture = ROOT.parent/'tests'/'fixtures'/'contact-documents'/'synthetic-resume.pdf'
            if not pdf_fixture.exists():
                pdf_fixture = Path('/usr/local/share/contact-sandbox/synthetic-resume.pdf')
            pdf = root/'synthetic.pdf'; pdf.write_bytes(pdf_fixture.read_bytes())
            png = root/'synthetic.png'
            image = Image.new('RGB', (1200,420), 'white')
            draw = ImageDraw.Draw(image)
            font = ImageFont.truetype('DejaVuSans.ttf', 72)
            draw.text((65,70), 'ROBIN VALE', fill='black', font=font)
            draw.text((65,200), 'SAMPLE STUDIO', fill='black', font=font)
            image.save(png)
            for source, file_type, words in ((pdf,'pdf',('LIN XIANG','ALPHA STUDIO')),
                                             (png,'png',('ROBIN','VALE','SAMPLE','STUDIO'))):
                with self.subTest(file_type=file_type):
                    original = source.read_bytes()
                    scratch = root/('scratch-'+file_type); scratch.mkdir()
                    code = f"""
from pathlib import Path
from contact_worker import sandbox
sandbox._landlock_abi=lambda _:1
sandbox.enter(Path({str(source)!r}),Path({str(scratch)!r}))
# All parser and Docling imports happen after the full production boundary.
from contact_worker.parser import parse
import json
blocks=parse(Path({str(source)!r}),{file_type!r},'abi1-feasibility')
assert blocks and all(block['text'].strip() and block.get('source_ref','').startswith('#/') for block in blocks), blocks
text=' '.join(block['text'] for block in blocks).upper()
assert all(word in text for word in {words!r}), text
print(json.dumps(blocks))
"""
                    child = subprocess.Popen([sys.executable,'-c',code],
                        env={'PATH':'/usr/bin:/bin','PYTHONPATH':str(ROOT)},
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                        start_new_session=True)
                    try:
                        stdout, stderr = child.communicate(timeout=120)
                        self.assertEqual(child.returncode, 0, stderr)
                        self.assertTrue(json.loads(stdout))
                    finally:
                        try: os.killpg(child.pid,signal.SIGKILL)
                        except ProcessLookupError: pass
                        child.communicate(timeout=5)
                    self.assertEqual(source.read_bytes(), original)


if __name__ == '__main__': unittest.main(defaultTest='SandboxTests')
