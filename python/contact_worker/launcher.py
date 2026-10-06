"""Trusted entrypoint: seal the process before loading any document parser."""
import json
import os
from pathlib import Path
import sys
from .diagnostics import emit


def main():
    mode, operation, source, scratch, file_type, limits, request_id = sys.argv[1:]
    try:
        if mode == 'hardened':
            from .sandbox import enter
            enter(Path(source), Path(scratch))
        elif mode != 'test-only' or os.environ.get('CONTACT_SANDBOX_TESTING') != '1':
            raise RuntimeError('SANDBOX_UNAVAILABLE')
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
            code = 'SANDBOX_UNAVAILABLE'
        if operation == 'parse':
            print(json.dumps(dict(version=1, request_id=request_id, kind='error',
                                  error=dict(code=code, message=code))), flush=True)
        else:
            print(code, flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
