import io
import json
import unittest
from contact_worker.diagnostics import emit


class DiagnosticTests(unittest.TestCase):
    def test_cause_is_retained_without_exception_text_or_paths(self):
        try:
            try:
                raise PermissionError(13, 'private-token', '/tmp/private-resume.pdf')
            except OSError as error:
                raise RuntimeError('CONVERSION_FAILED') from error
        except RuntimeError as error:
            stream = io.StringIO()
            emit(error, stream)
        text = stream.getvalue()
        result = json.loads(text.removeprefix('CONTACT_DIAGNOSTIC '))
        self.assertEqual([item['type'] for item in result['exceptions']], ['RuntimeError', 'PermissionError'])
        self.assertEqual(result['exceptions'][1]['errno'], 13)
        self.assertTrue(result['exceptions'][0]['frames'])
        self.assertNotIn('private-token', text)
        self.assertNotIn('private-resume', text)
        self.assertNotIn('/tmp/', text)

    def test_cause_chain_is_bounded(self):
        error = RuntimeError('private')
        for _ in range(20):
            next_error = RuntimeError('secret')
            next_error.__cause__ = error
            error = next_error
        stream = io.StringIO()
        emit(error, stream)
        result = json.loads(stream.getvalue().removeprefix('CONTACT_DIAGNOSTIC '))
        self.assertEqual(len(result['exceptions']), 4)


if __name__ == '__main__':
    unittest.main()
