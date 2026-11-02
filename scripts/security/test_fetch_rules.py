import hashlib
import importlib.util
import io
import pathlib
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('fetch_rules', pathlib.Path(__file__).with_name('fetch_rules.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuleFetchTests(unittest.TestCase):
    def fixture(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            for path, content in [('LICENSE', b'upstream license'), ('javascript/rule.yaml', b'rules: []\n')]:
                info = tarfile.TarInfo('semgrep-rules-' + 'a' * 40 + '/' + path)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        data = data.getvalue()
        manifest = {'upstreamCommit': 'a' * 40, 'archiveSha256': hashlib.sha256(data).hexdigest(), 'paths': ['javascript/rule.yaml']}
        return data, manifest

    def test_retains_exact_selected_rules_and_upstream_license(self):
        data, manifest = self.fixture()
        with tempfile.TemporaryDirectory() as output:
            module.unpack_verified(data, manifest, pathlib.Path(output))
            self.assertEqual(pathlib.Path(output, 'javascript/rule.yaml').read_bytes(), b'rules: []\n')
            self.assertEqual(pathlib.Path(output, 'LICENSE').read_bytes(), b'upstream license')

    def test_rejects_wrong_checksum_before_writing(self):
        data, manifest = self.fixture()
        with tempfile.TemporaryDirectory() as output:
            with self.assertRaises(ValueError):
                module.unpack_verified(data + b'changed', manifest, pathlib.Path(output))
            self.assertEqual(list(pathlib.Path(output).iterdir()), [])

    def test_rejects_traversal_paths_and_missing_rule_members(self):
        data, manifest = self.fixture()
        for path in ['../escaped.yaml', '/tmp/escaped.yaml', 'javascript/missing.yaml']:
            with tempfile.TemporaryDirectory() as output:
                with self.assertRaises((ValueError, KeyError)):
                    module.unpack_verified(data, {**manifest, 'paths': [path]}, pathlib.Path(output))
                self.assertEqual(list(pathlib.Path(output).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
