"""No macOS dependency: verify the native setup order and its cleanup contract."""
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from safari_file_entry import prepare_native_file_entry


class NativeFileEntryTests(unittest.TestCase):
    def test_fresh_owner_and_native_folder_access_precede_app_navigation(self):
        with tempfile.TemporaryDirectory(prefix='shorts native ') as folder:
            entry = (Path(folder) / 'Shorts-Studio.html').as_uri()
            calls = []
            def command(method, path, data=None):
                calls.append((method, path, data))
                return 'old' if method == 'GET' else {'handle': 'fresh'}
            def opened(args, check):
                self.assertEqual(args[:4], ['/usr/bin/open', '-g', '-a', 'Safari'])
                self.assertTrue(check)
                grant = Path(args[-1])
                self.assertEqual(grant.parent, Path(folder))
                self.assertNotIn(b'<script', grant.read_bytes())
                self.assertEqual(calls, [('GET','/window',None),('POST','/window/new',{'type':'window'}),('POST','/window',{'handle':'old'}),('DELETE','/window',None),('POST','/window',{'handle':'fresh'})])
            with patch('safari_file_entry.subprocess.run', side_effect=opened):
                grant = prepare_native_file_entry(entry, command)
            self.assertTrue(grant.is_file())
            grant.unlink()

    def test_native_access_failure_removes_temporary_sibling_and_propagates(self):
        with tempfile.TemporaryDirectory() as folder:
            def command(*args): return {'handle':'fresh'}
            with patch('safari_file_entry.subprocess.run', side_effect=subprocess.CalledProcessError(1,'open')):
                with self.assertRaises(subprocess.CalledProcessError):
                    prepare_native_file_entry((Path(folder)/'app.html').as_uri(), command)
            self.assertEqual(list(Path(folder).iterdir()), [])

    def test_http_or_remote_file_cannot_use_the_file_access_protocol(self):
        for entry in ['https://example.com/app.html','file://remote/app.html']:
            with self.assertRaises(ValueError):
                prepare_native_file_entry(entry, lambda *args:self.fail('Unexpected browser mutation'))


if __name__ == '__main__': unittest.main(verbosity=2)
