"""Fail-closed Linux filesystem + syscall boundary, before parser imports.

Requires Landlock ABI >= 3 and libseccomp. No privileges or compilation.
The supervisor creates a process group and kills that group on every outcome.
"""
from __future__ import annotations

import ctypes as C
import errno
import os
from pathlib import Path
import platform
import resource
import sys


class SandboxError(RuntimeError):
    pass


class Ruleset(C.Structure):
    _fields_ = [("handled_access_fs", C.c_uint64)]


class PathRule(C.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", C.c_uint64), ("parent_fd", C.c_int32)]


class Compare(C.Structure):
    _fields_ = [("arg", C.c_uint), ("op", C.c_int),
                ("datum_a", C.c_uint64), ("datum_b", C.c_uint64)]


def _check(result):
    if result < 0:
        raise SandboxError("SANDBOX_UNAVAILABLE")
    return result


def _seccomp():
    lib = C.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.argtypes = [C.c_uint32]
    lib.seccomp_init.restype = C.c_void_p
    lib.seccomp_release.argtypes = [C.c_void_p]
    lib.seccomp_load.argtypes = [C.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [C.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [C.c_void_p, C.c_uint32, C.c_int, C.c_uint, C.POINTER(Compare)]
    ctx = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW; non-native ABI killed by libseccomp.
    if not ctx:
        raise SandboxError("SANDBOX_UNAVAILABLE")
    def deny(name, error=errno.EPERM, comparisons=()):
        number = lib.seccomp_syscall_resolve_name(name.encode())
        if number == -1:
            raise SandboxError("SANDBOX_UNAVAILABLE")
        conditions = (Compare * len(comparisons))(*comparisons)
        _check(lib.seccomp_rule_add_array(ctx, 0x50000 | error, number,
                                        len(conditions), conditions))
    try:
        for name in ("socket", "socketpair", "connect", "bind", "listen", "accept", "accept4",
                     "sendto", "sendmsg", "sendmmsg", "recvmsg", "recvmmsg", "ptrace",
                     "process_vm_readv", "process_vm_writev", "pidfd_getfd", "pidfd_open",
                     "pidfd_send_signal", "io_uring_setup", "io_uring_enter", "io_uring_register",
                     "setsid", "setpgid", "unshare", "setns", "mount", "umount2", "pivot_root",
                     "open_by_handle_at", "bpf", "perf_event_open", "userfaultfd", "keyctl",
                     "add_key", "request_key", "kill", "tkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo"):
            deny(name)
        # clone3 arguments live behind a pointer. Force libc's legacy clone fallback.
        deny("clone3", errno.ENOSYS)
        # A child cannot change namespace or parent to escape supervisor ownership.
        for flag in (0x80, 0x8000, 0x20000, 0x2000000, 0x4000000, 0x8000000,
                     0x10000000, 0x20000000, 0x40000000):
            deny("clone", comparisons=(Compare(0, 7, flag, flag),))  # MASKED_EQ
        deny("tgkill", comparisons=(Compare(0, 1, os.getpid(), 0),))  # NE: own threads only
        # glibc/Python self getrlimit/setrlimit use pid=0; descendants retain
        # that meaning. Explicit PIDs must not lower the same-UID broker's limits.
        deny("prlimit64", comparisons=(Compare(0, 1, 0, 0),))
        # kill denial alone cannot block kernel-generated SIGIO/SIGURG. Keep
        # ordinary fcntl/ioctl operations, but prohibit signal ownership/configuration
        # and async enabling, including on inherited standard I/O descriptions.
        # Kernel cmd/request arguments are 32-bit; mask upper bits to prevent bypass.
        for command in (8, 10, 15):  # F_SETOWN, F_SETSIG, F_SETOWN_EX
            deny("fcntl", comparisons=(Compare(1, 7, 0xffffffff, command),))
        deny("fcntl", comparisons=(Compare(1, 7, 0xffffffff, 4),  # F_SETFL
                                   Compare(2, 7, 0x2000, 0x2000)))  # O_ASYNC
        for request in (0x8901, 0x8902, 0x5452):  # FIOSETOWN, SIOCSPGRP, FIOASYNC
            deny("ioctl", comparisons=(Compare(1, 7, 0xffffffff, request),))
        _check(lib.seccomp_load(ctx))
    finally:
        lib.seccomp_release(ctx)


def _runtime_paths():
    # Image-controlled immutable resources only; never a caller-provided parent.
    return [Path(__file__).resolve().parent, Path(sys.prefix),
            Path(sys.executable).resolve(), Path('/usr/lib'), Path('/usr/local/lib'),
            Path('/usr/share/fonts'), Path('/usr/share/fontconfig'), Path('/etc/fonts'),
            Path('/etc/ld.so.cache'), Path('/opt/contact-models'),
            Path('/proc/cpuinfo'), Path('/proc/meminfo')]


def enter(source: Path, scratch: Path, *, cpu_seconds=120, memory_bytes=3 * 1024**3,
          max_file_bytes=256 * 1024**2):
    if sys.platform != 'linux' or platform.machine() not in ('x86_64', 'aarch64'):
        raise SandboxError('SANDBOX_UNAVAILABLE')
    if source.is_symlink() or not source.is_file() or scratch.is_symlink() or not scratch.is_dir():
        raise SandboxError('INVALID_PATH')
    source, scratch = source.resolve(), scratch.resolve()
    if source == scratch or scratch in source.parents:
        raise SandboxError('INVALID_PATH')
    runtime = [p.resolve() for p in _runtime_paths() if p.exists()]
    if any(source == p or p in source.parents or scratch == p or p in scratch.parents for p in runtime):
        raise SandboxError('INVALID_PATH')
    # Landlock cannot revoke pre-opened file descriptions. Close every extra FD first.
    for entry in os.listdir('/proc/self/fd'):
        fd = int(entry)
        if fd > 2:
            try: os.close(fd)
            except OSError: pass
    os.chdir(scratch)
    os.environ.clear()
    os.environ.update(PATH='/usr/bin:/bin', HOME=str(scratch), TMPDIR=str(scratch),
                      HF_HOME='/opt/contact-models/hf', XDG_CACHE_HOME='/opt/contact-models/cache',
                      HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1',
                      OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1',
                      TOKENIZERS_PARALLELISM='false', LANG='C.UTF-8')
    for kind, cap in ((resource.RLIMIT_CPU, cpu_seconds), (resource.RLIMIT_AS, memory_bytes),
                      (resource.RLIMIT_FSIZE, max_file_bytes), (resource.RLIMIT_NPROC, 32),
                      (resource.RLIMIT_NOFILE, 128), (resource.RLIMIT_CORE, 0)):
        _, hard = resource.getrlimit(kind)
        cap = cap if hard == resource.RLIM_INFINITY else min(cap, hard)
        resource.setrlimit(kind, (cap, cap))
    libc = C.CDLL(None, use_errno=True)
    libc.syscall.restype = C.c_long
    _check(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
    # The supported x86_64/aarch64 syscall tables assign 444/445/446 to Landlock.
    abi = _check(libc.syscall(444, 0, 0, 1))
    if abi < 3:
        raise SandboxError('SANDBOX_UNAVAILABLE')
    handled = (1 << 15) - 1  # all ABI3 FS rights, including REFER and TRUNCATE
    attr = Ruleset(handled)
    ruleset = _check(libc.syscall(444, C.byref(attr), C.sizeof(attr), 0))
    def allow(path, rights):
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = PathRule(rights, fd)
            _check(libc.syscall(445, ruleset, 1, C.byref(rule), 0))
        finally:
            os.close(fd)
    try:
        for path in runtime:
            allow(path, 1 | 4 | (8 if path.is_dir() else 0))
        allow(source, 4)  # exact inode, read only; shared parent has no grant
        # scratch: ordinary files/directories/symlinks only, no device/FIFO/socket/exec
        allow(scratch, 2 | 4 | 8 | 16 | 32 | 128 | 256 | 4096 | 8192 | 16384)
        allow(Path('/dev/null'), 2 | 4)
        _check(libc.syscall(446, ruleset, 0))
    finally:
        os.close(ruleset)
    _seccomp()
