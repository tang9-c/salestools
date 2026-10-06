"""Bounded program metadata only: no messages, source lines, locals or paths."""
import json
import re
import sys
from pathlib import Path


def diagnostic(error):
    exceptions = []
    seen = set()
    while error is not None and id(error) not in seen and len(exceptions) < 4:
        seen.add(id(error))
        frames = []
        traceback = error.__traceback__
        while traceback is not None:
            code = traceback.tb_frame.f_code
            module = Path(code.co_filename).name
            function = code.co_name
            if (re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}\.py', module)
                    and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', function)):
                frames.append(dict(module=module, function=function, line=traceback.tb_lineno))
            traceback = traceback.tb_next
        kind = type(error).__name__
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', kind):
            kind = 'Exception'
        item = dict(type=kind, frames=frames[-4:])
        if isinstance(error, OSError) and isinstance(error.errno, int):
            item['errno'] = error.errno
        exceptions.append(item)
        error = error.__cause__
    return dict(exceptions=exceptions)


def emit(error, stream=None):
    stream = sys.stderr if stream is None else stream
    stream.write('CONTACT_DIAGNOSTIC ' + json.dumps(diagnostic(error), separators=(',', ':')) + '\n')
    stream.flush()
