import hashlib
import importlib.util
import io
import json
import shutil
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update_mobilesci', Path(__file__).with_name('update-mobilesci.py'))
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdateBundleTests(unittest.TestCase):
    def test_rehearsal_allows_migration_metadata_but_rejects_business_row_loss(self):
        import ast
        import sqlite3
        import sys
        source = Path(__file__).with_name('update-server.py').read_text()
        function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'rehearse_sqlite')
        scripts = {node.targets[0].id: node.value.value for node in function.body
                   if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                   and node.targets[0].id in ('script', 'verify')}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'state').mkdir()
            with sqlite3.connect(root / 'state/orx.db') as db:
                for name in ('projects', 'product_migrations', 'product_schema_migrations'):
                    db.execute(f'CREATE TABLE {name}(id INTEGER)')
                    db.execute(f'INSERT INTO {name} VALUES(1)')
            def execute(name):
                with patch.object(sys, 'argv', ['rehearsal', 'state/rehearsal']):
                    exec(scripts[name].replace('/home/node/research', directory), {})
            execute('script')
            self.assertEqual(json.loads((root / 'state/rehearsal/before.json').read_text()), {'projects': 1})
            with sqlite3.connect(root / 'state/rehearsal/orx.db') as db:
                db.execute('INSERT INTO product_schema_migrations VALUES(2)')
            execute('verify')
            with sqlite3.connect(root / 'state/rehearsal/orx.db') as db:
                db.execute('DELETE FROM projects')
            with self.assertRaisesRegex(AssertionError, 'projects'):
                execute('verify')

    def bundle(self, extra=None, corrupt=False):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'bundle.tgz'
        files = {'update-server.py': b'print("test")', 'workbench/orx': b'\x7fELFtest', 'workbench/Dockerfile': b'FROM test', 'platform/Dockerfile': b'FROM test', 'platform/dist/index.html': b'page'}
        manifest = {'format': 1, 'architecture': 'linux/amd64', 'commit': 'a' * 40, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
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

    def test_upload_requires_evidence_before_any_network_action(self):
        with patch.object(update, 'run', side_effect=AssertionError('must not contact server')):
            with self.assertRaisesRegex(ValueError, '--evidence'):
                update.upload(self.bundle())

    def test_evidence_must_bind_the_exact_bundle_and_binary(self):
        bundle = self.bundle()
        manifest = update.verify_bundle(bundle)
        evidence = bundle.parent / 'evidence.json'
        data = {'revision': manifest['commit'], 'components': {'workbench': {'artifactSha256': manifest['files']['workbench/orx']},
                               'platform': {'artifactSha256': update.digest(bundle)}}}
        evidence.write_text(json.dumps(data))
        with patch.object(update, 'run') as execute:
            update.authorize_upload(bundle, evidence)
            self.assertEqual(execute.call_args.args[0][1], update.ROOT / 'scripts/check-release-evidence.mjs')
        data['components']['platform']['artifactSha256'] = '0' * 64
        evidence.write_text(json.dumps(data))
        with patch.object(update, 'run', side_effect=AssertionError('must not contact server')):
            with self.assertRaisesRegex(ValueError, '产物与部署包不一致'):
                update.authorize_upload(bundle, evidence)

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
        with patch.object(update, 'OUTPUT', output), patch.object(update, 'fingerprint', return_value='same'), patch.object(update.subprocess, 'check_output', return_value='a' * 40), patch.object(update, 'run', side_effect=AssertionError('unexpected command')):
            self.assertEqual(update.prepare(), bundle)

    def test_cached_bundle_from_another_commit_is_not_reused(self):
        bundle = self.bundle()
        (bundle.parent / 'latest.json').write_text(json.dumps({'file': bundle.name, 'sha256': update.digest(bundle), 'fingerprint': 'same'}))
        with patch.object(update, 'OUTPUT', bundle.parent), patch.object(update, 'fingerprint', return_value='same'), patch.object(update.subprocess, 'check_output', return_value='b' * 40), patch.object(update, 'run', side_effect=RuntimeError('rebuild required')):
            with self.assertRaisesRegex(RuntimeError, 'rebuild required'):
                update.prepare()

    def test_package_contains_platform_dependencies_and_migrations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'Cargo.toml').write_text('version = "0.2.19"\n# 中文说明与 UTF-8 标点 “候选”\n', encoding='utf-8')
            for name in ['ui/dist/index.html', 'packages/platform/src/server.mjs', 'packages/platform/public/index.html', 'packages/platform/migrations/004.sql', 'packages/platform/package.json', 'packages/platform/package-lock.json', 'scripts/deploy/update-server.py', 'scripts/deploy/enable-personal-spaces.py', 'scripts/deploy/enable-opencode-admin.py']:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('test')

            def fake_run(args, **kwargs):
                if args[:2] == ['docker', 'cp']:
                    destination = Path(args[-1])
                    if destination.name == 'executor-tools':
                        shutil.copytree(Path(__file__).resolve().parents[2] / 'packages/platform/executor-tools', destination)
                        (destination / 'debs').mkdir()
                        (destination / 'debs/tools_amd64.deb').write_bytes(b'fixture')
                        (destination / 'bin').mkdir()
                        for name in ('uv', 'uvx'):
                            (destination / 'bin' / name).write_bytes(b'fixture')
                    elif destination.name == 'node_modules':
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
                for name in ['platform/package.json', 'platform/package-lock.json', 'platform/migrations/004.sql',
                             'workbench/executor-tools/bin/uv', 'workbench/executor-tools/debs/tools_amd64.deb']:
                    self.assertIn(name, manifest['files'])
                self.assertTrue(all('\\' not in name for name in manifest['files']))
                with tarfile.open(bundle) as archive:
                    self.assertEqual(archive.getmember('workbench/orx').mode, 0o755)
                    workbench = archive.extractfile('workbench/Dockerfile').read().decode()
                    self.assertIn('COPY --chmod=755 orx', workbench)
                    self.assertIn('sh /tmp/executor-tools/install.sh', workbench)
                    self.assertNotIn('apt-get', workbench)
                    self.assertIn('USER node\nRUN orx-check-executor-tools', workbench)
                    dockerfile = archive.extractfile('platform/Dockerfile').read().decode()
                    self.assertIn('COPY node_modules ./node_modules', dockerfile)
                    self.assertNotIn('RUN npm', dockerfile)
                    self.assertIn('COPY migrations ./migrations', dockerfile)
                offline = root / 'pdf-debs'
                offline.mkdir()
                (offline / 'poppler-utils_test_amd64.deb').write_bytes(b'offline package fixture')
                offline_bundle = update.prepare('test-image', offline)
                offline_manifest = update.verify_bundle(offline_bundle)
                self.assertIn('workbench/pdf-debs/poppler-utils_test_amd64.deb', offline_manifest['files'])
                with tarfile.open(offline_bundle) as archive:
                    dockerfile = archive.extractfile('workbench/Dockerfile').read().decode()
                    self.assertIn('dpkg -i /tmp/pdf-debs/*.deb', dockerfile)
                    self.assertNotIn('apt-get update', dockerfile)
                (offline / 'poppler-utils_test_amd64.deb').unlink()
                with self.assertRaisesRegex(ValueError, '离线 PDF 依赖'):
                    update.prepare('test-image', offline)


if __name__ == '__main__':
    unittest.main()
