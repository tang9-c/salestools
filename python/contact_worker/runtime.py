"""Prepare a parser subprocess. Isolation and memory/PID limits belong to its container."""
import os
from pathlib import Path
import resource


# Two cores can consume 240 CPU seconds within the 120-second wall deadline; allow headroom.
def prepare(source: Path, scratch: Path, *, cpu_seconds=300, max_file_bytes=256 * 1024**2):
    if not source.is_absolute() or not scratch.is_absolute() or source.is_symlink() \
            or not source.is_file() or scratch.is_symlink() or not scratch.is_dir():
        raise RuntimeError('INVALID_PATH')
    source, scratch = source.resolve(), scratch.resolve()
    if source == scratch or scratch in source.parents:
        raise RuntimeError('INVALID_PATH')
    # Only broker-selected cache paths survive; never inherit application credentials.
    cache = {key: os.environ[key] for key in ('HF_HOME', 'XDG_CACHE_HOME') if key in os.environ}
    for entry in os.listdir('/proc/self/fd' if Path('/proc/self/fd').exists() else '/dev/fd'):
        fd = int(entry)
        if fd > 2:
            try:
                os.close(fd)
            except OSError:
                pass
    os.chdir(scratch)
    os.environ.clear()
    os.environ.update(PATH='/usr/bin:/bin', HOME=str(scratch), TMPDIR=str(scratch),
        HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1',
        HF_DEACTIVATE_ASYNC_LOAD='1', OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1',
        MKL_NUM_THREADS='1', TOKENIZERS_PARALLELISM='false', LANG='C.UTF-8', **cache)
    # Do not impose per-process address-space or per-UID thread ceilings on Docling.
    for kind, cap in ((resource.RLIMIT_CPU, cpu_seconds), (resource.RLIMIT_FSIZE, max_file_bytes),
                      (resource.RLIMIT_NOFILE, 128), (resource.RLIMIT_CORE, 0)):
        soft, hard = resource.getrlimit(kind)
        cap = min([cap] + [value for value in (soft, hard) if value != resource.RLIM_INFINITY])
        resource.setrlimit(kind, (cap, cap))
