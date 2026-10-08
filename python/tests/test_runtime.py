"""Ordinary process setup, not a kernel security boundary."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RuntimeTests(unittest.TestCase):
    def test_cpu_budget_allows_two_core_parsing_and_respects_tighter_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'document.pdf'
            source.write_bytes(b'%PDF-')
            scratch = root / 'scratch'
            scratch.mkdir()
            code = '''
import json,resource,sys
from pathlib import Path
from contact_worker.runtime import prepare
mode=sys.argv[3]
if mode=='inherited': resource.setrlimit(resource.RLIMIT_CPU,(90,90))
prepare(Path(sys.argv[1]),Path(sys.argv[2]),**({'cpu_seconds':1} if mode=='probe' else {}))
print(json.dumps(resource.getrlimit(resource.RLIMIT_CPU)))
'''
            for mode, expected in [('default', [300, 300]), ('inherited', [90, 90]), ('probe', [1, 1])]:
                with self.subTest(mode=mode):
                    result = subprocess.run([sys.executable, '-c', code, str(source), str(scratch), mode],
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), expected)

    def test_setup_keeps_container_limits_and_clears_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'document.pdf'
            source.write_bytes(b'%PDF-')
            scratch = root / 'scratch'
            scratch.mkdir()
            code = '''
import json,os,resource,sys
from pathlib import Path
from contact_worker.runtime import prepare
before={str(k):resource.getrlimit(k) for k in (resource.RLIMIT_AS,resource.RLIMIT_NPROC)}
prepare(Path(sys.argv[1]),Path(sys.argv[2]))
assert 'SERVICE_SECRET' not in os.environ
assert os.environ['HF_DEACTIVATE_ASYNC_LOAD']=='1'
assert os.environ['HF_HUB_OFFLINE']=='1'
assert Path.cwd()==Path(sys.argv[2]).resolve()
assert resource.getrlimit(resource.RLIMIT_CORE)==(0,0)
assert before=={str(k):resource.getrlimit(k) for k in (resource.RLIMIT_AS,resource.RLIMIT_NPROC)}
assert resource.getrlimit(resource.RLIMIT_NOFILE)[0]<=128
try: os.fstat(int(sys.argv[3]))
except OSError as error: assert error.errno==9
else: raise AssertionError('inherited file descriptor remained open')
print('ready')
'''
            with source.open('rb') as inherited:
                result = subprocess.run([sys.executable, '-c', code, str(source), str(scratch), str(inherited.fileno())],
                    pass_fds=(inherited.fileno(),), env={**os.environ, 'SERVICE_SECRET': 'never-forward'},
                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'ready')

    def test_symlink_source_is_rejected(self):
        from contact_worker.runtime import prepare
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'source').write_bytes(b'x')
            (root / 'link').symlink_to(root / 'source')
            with self.assertRaisesRegex(RuntimeError, 'INVALID_PATH'):
                prepare(root / 'link', root)


if __name__ == '__main__':
    unittest.main()
