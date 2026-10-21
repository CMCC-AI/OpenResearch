import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('opencode_deployment', Path(__file__).with_name('enable-opencode-admin.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UnifiedOpenCodeTests(unittest.TestCase):
    def test_executor_migration_preserves_home_auth_and_runtime_isolation(self):
        old = {'Config': {'Image': 'old', 'Env': ['KEEP=value', 'MANAGED_CONFIG_SEED_DIR=/run/orx-seed/opencode']},
               'HostConfig': {'Binds': ['orx-managed-fixture:/home/node', '/shared:/run/orx-seed/opencode:ro', '/auth.json:/run/orx-seed/auth.json:ro'], 'Memory': 1073741824, 'CapDrop': ['ALL']}}
        before = copy.deepcopy(old)
        config, host = module.desired_executor(old, 'new-image')
        self.assertEqual(config['Image'], 'new-image')
        self.assertEqual(config['Env'], ['KEEP=value'])
        self.assertIn('orx-managed-fixture:/home/node', host['Binds'])
        self.assertIn('/auth.json:/run/orx-seed/auth.json:ro', host['Binds'])
        self.assertIn(module.SHARED + ':' + module.TARGET + ':ro', host['Binds'])
        self.assertFalse(any('/run/orx-seed/opencode' in bind for bind in host['Binds']))
        self.assertEqual(host['Memory'], before['HostConfig']['Memory'])
        self.assertEqual(old, before)

    def test_persisted_compose_uses_internal_api_and_live_config_for_future_spaces(self):
        original = {'services': {'platform': {'environment': {'DATABASE_URL': '${DATABASE_URL}'}, 'depends_on': ['db']}, 'provisioner': {'environment': {'MANAGED_OPENCODE_CONFIG_DIR': '/old', 'PRIVATE_SETTING': 'keep'}}}}
        desired = module.desired_compose(original, 'workbench', 'executor')
        self.assertEqual(desired['services']['platform']['environment']['DATABASE_URL'], '${DATABASE_URL}')
        self.assertIn('opencode-admin', desired['services']['platform']['depends_on'])
        env = desired['services']['provisioner']['environment']
        self.assertNotIn('MANAGED_OPENCODE_CONFIG_DIR', env)
        self.assertEqual(env['MANAGED_OPENCODE_LIVE_CONFIG_DIR'], module.SHARED)
        self.assertEqual(env['MANAGED_EXECUTOR_IMAGE'], 'executor')
        self.assertEqual(env['PRIVATE_SETTING'], 'keep')
        admin = desired['services']['opencode-admin']
        self.assertIn('127.0.0.1', ' '.join(admin['command']))
        self.assertNotIn('ports', admin)
        self.assertTrue(admin['read_only'])
        self.assertNotIn('opencode-admin', original['services'])

    def test_fresh_deployment_uses_official_api_and_retains_settings_on_upgrade(self):
        spec = importlib.util.spec_from_file_location('mobilesci_for_opencode', Path(__file__).with_name('mobilesci.py'))
        deployment = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deployment)
        text = deployment.compose_text('test')
        self.assertIn('OPENCODE_ADMIN_URL: http://127.0.0.1:4970', text)
        self.assertIn('depends_on: [opencode-admin]', text)
        self.assertIn('  opencode-admin:', text)
        server = Path(__file__).with_name('server.sh').read_text()
        self.assertIn('! -f $root/state/opencode/opencode.jsonc', server)
        self.assertIn('! -f $root/state/opencode-auth/auth.json', server)


if __name__ == '__main__':
    unittest.main()
