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

    def test_applied_migration_preserves_only_verified_historical_line_endings(self):
        import ast
        source = Path(__file__).with_name('update-server.py').read_text()
        function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'historical_migration')
        namespace = {'hashlib': hashlib}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<historical_migration>', 'exec'), namespace)
        preserve = namespace['historical_migration']
        lf = b'CREATE TABLE fixture(id uuid);\n'
        crlf = lf.replace(b'\n', b'\r\n')
        recorded = hashlib.sha256(crlf).hexdigest()
        self.assertEqual(preserve(lf, recorded, crlf), crlf)
        self.assertEqual(preserve(crlf, recorded, crlf), crlf)
        with self.assertRaises(RuntimeError):
            preserve(b'DROP TABLE fixture;\n', recorded, crlf)
        with self.assertRaises(RuntimeError):
            preserve(lf, recorded, b'Unverified deployed source')

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

    def test_literature_callback_drift_blocks_upgrade_before_replacement(self):
        import ast
        source = Path(__file__).with_name('update-server.py').read_text()
        function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'validate_literature_config')
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<validate_literature_config>', 'exec'), namespace)
        validate = namespace['validate_literature_config']
        validate({'Env': []})
        origin = 'DEEPLIT_ORIGIN=http://61.136.101.179:20281'
        validate({'Env': [origin, 'DEEPLIT_WEB_PATH=/deepxiv']})
        for suffix in ([], ['DEEPLIT_WEB_PATH='], ['DEEPLIT_WEB_PATH=/wrong']):
            with self.subTest(suffix=suffix), self.assertRaisesRegex(RuntimeError, 'DEEPLIT_WEB_PATH=/deepxiv'):
                validate({'Env': [origin, *suffix]})

    def test_corrupt_binary_is_rejected(self):
        with self.assertRaisesRegex(ValueError, '校验失败'):
            update.verify_bundle(self.bundle(corrupt=True))

    def test_traversal_and_symlinks_are_rejected_before_extraction(self):
        for name in ['../outside', '/tmp/outside', 'C:/outside', '..\\outside']:
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

    def test_package_contains_platform_dependencies_and_migrations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'Cargo.toml').write_text('version = "0.2.19"\n')
            for name in ['ui/dist/index.html', 'packages/platform/src/server.mjs', 'packages/platform/public/index.html', 'packages/platform/migrations/004.sql', 'packages/platform/package.json', 'packages/platform/package-lock.json', 'scripts/deploy/update-server.py', 'scripts/deploy/enable-personal-spaces.py', 'scripts/deploy/enable-opencode-admin.py']:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('test')

            def fake_run(args, **kwargs):
                if args[:2] == ['docker', 'cp']:
                    destination = Path(args[-1])
                    if destination.name == 'node_modules':
                        destination.mkdir()
                        (destination / 'package.json').write_text('{}')
                    else:
                        destination.write_bytes(b'\x7fELFtest')

            def output(args, **kwargs):
                if args[:3] == ['docker', 'image', 'inspect']:
                    return 'amd64\n'
                return 'test-id\n'

            with patch.object(update, 'ROOT', root), patch.object(update, 'OUTPUT', root / 'output'), patch.object(update, 'fingerprint', return_value='test-source'), patch.object(update, 'run', side_effect=fake_run), patch.object(update.subprocess, 'check_output', side_effect=output):
                bundle = update.prepare('test-image')
                manifest = update.verify_bundle(bundle)
                for name in ['platform/package.json', 'platform/package-lock.json', 'platform/migrations/004.sql']:
                    self.assertIn(name, manifest['files'])
                self.assertTrue(all('\\' not in name for name in manifest['files']))
                with tarfile.open(bundle) as archive:
                    self.assertEqual(archive.getmember('workbench/orx').mode, 0o755)
                    self.assertIn('COPY --chmod=755 orx', archive.extractfile('workbench/Dockerfile').read().decode())
                    dockerfile = archive.extractfile('platform/Dockerfile').read().decode()
                    self.assertIn('COPY node_modules ./node_modules', dockerfile)
                    self.assertNotIn('RUN npm', dockerfile)
                    self.assertIn('COPY migrations ./migrations', dockerfile)


if __name__ == '__main__':
    unittest.main()
