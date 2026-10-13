import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sona', Path(__file__).with_name('sona.py'))
sona = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sona)


class DeploymentTests(unittest.TestCase):
    def archive(self, member='20261013T000000Z-aabbcc/manifest.json', kind=None, browser_session_read=1):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        path = Path(temp.name) / 'bundle.tgz'
        with tarfile.open(path, 'w:gz') as tar:
            data = json.dumps({'browserSessionReadVersion': browser_session_read, 'deploymentFormat': 3, 'literatureMode': 'existing-server-sso', 'appPath': '/sona', 'architecture': 'linux/amd64', 'credentialsIncluded': False}).encode()
            info = tarfile.TarInfo(member)
            info.size = len(data)
            if kind:
                info.type = kind
                info.linkname = '/etc/passwd'
            tar.addfile(info, io.BytesIO(data))
        return path

    def test_manifest_is_read_without_extracting(self):
        release, data = sona.inspect_bundle(self.archive())
        self.assertEqual(release, '20261013T000000Z-aabbcc')
        self.assertEqual(data['architecture'], 'linux/amd64')

    def test_bundle_without_browser_login_fix_rejected(self):
        with self.assertRaisesRegex(ValueError, '浏览器登录修复'):
            sona.inspect_bundle(self.archive(browser_session_read=0))

    def test_tar_traversal_rejected(self):
        for path in ('../manifest.json', '/etc/manifest.json'):
            with self.assertRaises(ValueError):
                sona.inspect_bundle(self.archive(path))

    def test_tar_link_rejected(self):
        with self.assertRaises(ValueError):
            sona.inspect_bundle(self.archive(kind=tarfile.SYMTYPE))

    def test_macos_paths_and_unbundled_mcps_rejected(self):
        for text in ('{"x":"/Users/test/file"}', '{"url":"http://localhost:8000"}', '{"x":"{env:API_KEY}"}', '{"command":["unsupported-cli"]}'):
            with self.assertRaises(ValueError):
                sona.validate_config(text)
        sona.validate_config('{"command":["codegraph","serve","--mcp"]}')

    def test_remote_architecture_mismatch_prevents_upload(self):
        with patch.object(sona.subprocess, 'check_output', return_value='aarch64\n'), patch.object(sona, 'run') as run:
            with self.assertRaises(ValueError):
                sona.deploy(self.archive())
            run.assert_not_called()

    def test_scp_port_and_verified_server_execution(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        with patch.object(sona, 'ROOT', Path(temp.name)), patch.object(sona.subprocess, 'check_output', return_value='x86_64\n'), patch.object(sona, 'run') as run, patch.object(sona.urllib.request, 'urlopen') as public:
            public.return_value.__enter__.return_value.read.return_value = b'{"ok":true,"version":"0.2.18"}'
            import types
            from unittest.mock import MagicMock
            peer=types.ModuleType('deploy_peer');peer.deploy_literature_peer=MagicMock()
            with patch.dict('sys.modules', {'deploy_peer': peer}): sona.deploy(self.archive())
            calls = [call.args[0] for call in run.call_args_list]
            scp = next(cmd for cmd in calls if cmd[0] == 'scp')
            self.assertEqual(scp[1:3], ['-P', '20280'])
            self.assertIn('ubuntu@61.136.101.179:', scp[-1])
            command = next(cmd[-1] for cmd in calls if 'sudo -n bash' in cmd[-1])
            self.assertLess(command.index('sha256sum -c'), command.index('sudo -n bash'))
            self.assertNotIn('StrictHostKeyChecking=no', str(calls))

    def test_runtime_credentials_never_in_image_build(self):
        dockerfile = Path(__file__).with_name('Dockerfile.workbench').read_text()
        self.assertNotIn('auth.json', dockerfile)
        self.assertIn('npm ci', dockerfile)
        self.assertIn('node_modules', dockerfile)


if __name__ == '__main__':
    unittest.main()
