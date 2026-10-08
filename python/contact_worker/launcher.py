"""Trusted entrypoint: prepare an ordinary subprocess before parser imports."""
import json
import os
from pathlib import Path
import sys
from .diagnostics import emit


def main():
    operation, source, scratch, file_type, limits, request_id = sys.argv[1:]
    try:
        from .runtime import prepare
        prepare(Path(source), Path(scratch))
        if operation == 'parse':
            from .main import serve
            serve()
        elif operation == 'preflight':
            from .parser import preflight
            preflight(Path(source), file_type, json.loads(limits))
        else:
            raise RuntimeError('INVALID_OPERATION')
    except Exception as error:
        emit(error)
        code = str(error)
        if not code.isascii() or not code.replace('_', '').isalnum() or not code.isupper() or len(code) > 64:
            code = 'WORKER_INIT_FAILED'
        if operation == 'parse':
            print(json.dumps(dict(version=1, request_id=request_id, kind='error',
                                  error=dict(code=code, message=code))), flush=True)
        else:
            print(code, flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
