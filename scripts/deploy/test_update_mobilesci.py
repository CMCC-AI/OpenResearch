import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update_mobilesci', Path(__file__).with_name('update-mobilesci.py'))
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdateBundleTests(unittest.TestCase):
    def bundle(self, extra=None, corrupt=False):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'bundle.tgz'
        files = {'update-server.py': b'print("test")', 'workbench/orx': b'\x7fELFtest', 'workbench/Dockerfile': b'FROM test', 'platform/Dockerfile': b'FROM test', 'platform/dist/index.html': b'page'}
        manifest = {'format': 1, 'architecture': 'linux/amd64', 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        if corrupt:
            files['workbench/orx'] = b'corrupt'
        files['manifest.json'] = json.dumps(manifest).encode()
        with tarfile.open(path, 'w:gz') as tar:
            for name, data in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
            if extra:
                tar.addfile(extra)
        return path

    def test_build_tags_local_image_id_before_using_it_as_base(self):
        import ast
        source = Path(__file__).with_name('update-server.py').read_text()
        function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'build_service')
        calls = []
        namespace = {'cmd': lambda *args: calls.append(args)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<build_service>', 'exec'), namespace)
        namespace['build_service']('workbench', 'sha256:abc123', '/tmp/context', 'release')
        self.assertEqual(calls[0], ('docker', 'tag', 'sha256:abc123', 'mobilesci-update-base-workbench:release'))
        self.assertIn('BASE_IMAGE=mobilesci-update-base-workbench:release', calls[1])
        self.assertNotIn('BASE_IMAGE=sha256:abc123', calls[1])

    def test_health_probe_keeps_workbench_loopback_host(self):
        import ast
        source = Path(__file__).with_name('update-server.py').read_text()
        function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'health_headers')
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<health_headers>', 'exec'), namespace)
        self.assertIsNone(namespace['health_headers']('workbench'))
        self.assertEqual(namespace['health_headers']('platform'), {'Host': '61.136.101.179:20281'})

    def test_complete_bundle_verifies(self):
        self.assertEqual(update.verify_bundle(self.bundle())['architecture'], 'linux/amd64')

    def test_corrupt_binary_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '校验失败'):
            update.verify_bundle(self.bundle(corrupt=True))

    def test_traversal_and_symlinks_are_rejected_before_extraction(self):
        for name in ['../outside', '/tmp/outside']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                update.verify_bundle(self.bundle(tarfile.TarInfo(name)))
        link = tarfile.TarInfo('link')
        link.type = tarfile.SYMTYPE
        link.linkname = '/etc/passwd'
        with self.assertRaises(ValueError):
            update.verify_bundle(self.bundle(link))

    def test_prepared_bundle_reuses_without_docker_or_server(self):
        bundle = self.bundle()
        output = bundle.parent
        (output / 'latest.json').write_text(json.dumps({'file': bundle.name, 'sha256': update.digest(bundle), 'fingerprint': 'same'}))
        with patch.object(update, 'OUTPUT', output), patch.object(update, 'fingerprint', return_value='same'), patch.object(update, 'run', side_effect=AssertionError('unexpected command')):
            self.assertEqual(update.prepare(), bundle)


if __name__ == '__main__':
    unittest.main()
