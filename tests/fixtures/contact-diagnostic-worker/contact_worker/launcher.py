"""Synthetic wire fixture; no document access or parser dependency."""
import json
import sys

request_id = sys.argv[-1]
sys.stderr.write('library noise ' * 2000 + '\n')
sys.stderr.write('CONTACT_PHASE conversion_started\n')
sys.stderr.write('CONTACT_PHASE secret-document.pdf\n')
metadata = json.dumps(dict(exceptions=[dict(type='PermissionError', errno=13,
                    frames=[dict(module='parser.py', function='parse', line=7)])]))
# Deliberately split the diagnostic across writes after an oversized noise line.
sys.stderr.write('CONTACT_DIAG')
sys.stderr.flush()
sys.stderr.write('NOSTIC ' + metadata + '\n')
sys.stderr.flush()
print(json.dumps(dict(version=1, request_id=request_id, kind='error',
                     error=dict(code='CONVERSION_FAILED', message='CONVERSION_FAILED'))), flush=True)
