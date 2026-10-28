import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('opencode_deployment', Path(__file__).with_name('enable-opencode-admin.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UnifiedOpenCodeTests(unittest.TestCase):
    def test_executor_scope_requires_current_platform_workspace_and_exact_name(self):
        item = {'Name': '/orx-managed-owned', 'Config': {'Labels': {'openresearch.managed': 'true', 'openresearch.workspace': 'owned'}}}
        self.assertTrue(module.owned_runtime(item, {'owned'}))
        self.assertFalse(module.owned_runtime(item, {'unrelated'}))
        item['Config']['Labels']['openresearch.managed'] = 'false'
        self.assertFalse(module.owned_runtime(item, {'owned'}))
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

    def test_replaced_executor_retains_user_tool_path_without_duplicates(self):
        old = {'Config': {'Env': ['PATH=/usr/local/bin:/usr/bin', 'KEEP=value']}, 'HostConfig': {'Binds': []}}
        config, host = module.desired_executor(old, 'tools-image')
        self.assertIn('PATH=/home/node/.local/bin:/usr/local/bin:/usr/bin', config['Env'])
        repeated, _ = module.desired_executor({'Config': config, 'HostConfig': host}, 'tools-image')
        self.assertEqual(repeated['Env'], config['Env'])
        self.assertEqual(old['Config']['Env'][0], 'PATH=/usr/local/bin:/usr/bin')

    def test_recommended_configuration_removes_only_superseded_sources(self):
        original = {'OPENCODE_ADMIN_CONFIG_FILE': '/old/config.json', 'DATABASE_URL': 'keep'}
        platform = module.official_platform_environment(original)
        self.assertNotIn('OPENCODE_ADMIN_CONFIG_FILE', platform)
        self.assertEqual(platform['OPENCODE_ADMIN_URL'], module.URL)
        self.assertEqual(platform['DATABASE_URL'], 'keep')
        self.assertIn('OPENCODE_ADMIN_CONFIG_FILE', original)
        old = {'MANAGED_OPENCODE_CONFIG_DIR': '/old', 'MANAGED_OPENCODE_CONFIG_FILE': '/old/file.json', 'MANAGED_OPENCODE_AUTH_FILE': '/private/auth.json', 'MANAGED_LEGACY_WORKSPACE': 'owner', 'MANAGED_CONNECTOR_IMAGE': 'connector'}
        env = module.live_provisioner_environment(old, 'new-executor')
        self.assertNotIn('MANAGED_OPENCODE_CONFIG_DIR', env)
        self.assertNotIn('MANAGED_OPENCODE_CONFIG_FILE', env)
        self.assertEqual(env['MANAGED_OPENCODE_LIVE_CONFIG_DIR'], module.SHARED)
        for key in ('MANAGED_OPENCODE_AUTH_FILE', 'MANAGED_LEGACY_WORKSPACE', 'MANAGED_CONNECTOR_IMAGE'):
            self.assertEqual(env[key], old[key])

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
