import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('runtime_pool_deploy', Path(__file__).with_name('update-runtime-pool.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimePoolDeploymentTest(unittest.TestCase):
    def test_persisted_and_replacement_environment_match_without_changing_research(self):
        env = {'MANAGED_CAPACITY': '2', 'MANAGED_EXECUTOR_IMAGE': 'existing-executor',
               'MANAGED_EXECUTOR_MEMORY': '2684354560', 'KEEP_AUTH': 'test-only',
               'MANAGED_OPENCODE_AUTH_FILE': '/private/auth.json'}
        old = {'Config': {'Image': 'original', 'Env': [f'{k}={v}' for k, v in env.items()],
                          'Labels': {'keep': 'label'}, 'Cmd': ['node', 'src/provisioner.mjs']},
               'HostConfig': {'NetworkMode': 'host', 'Binds': ['/var/run/docker.sock:/var/run/docker.sock']}}
        compose = {'services': {name: {'image': 'original', 'environment': dict(env)}
                                for name in ['platform', 'provisioner']}}
        persisted = module.desired_compose(compose, 'candidate', 2)
        config, host = module.desired_config(old, 'candidate', 'test-stamp', 2, True)
        self.assertEqual(module.environment(config), persisted['services']['provisioner']['environment'])
        self.assertEqual(host, old['HostConfig'])
        self.assertEqual(config['Cmd'], old['Config']['Cmd'])
        self.assertEqual(config['Labels']['keep'], 'label')
        for key, value in env.items():
            self.assertEqual(module.environment(config)[key], value)
        self.assertNotIn('MANAGED_IDLE_SECONDS', env)
        self.assertEqual(old['Config']['Image'], 'original')
        self.assertEqual(compose['services']['platform']['image'], 'original')

    def test_platform_preserves_origins_credentials_and_quota(self):
        old = {'Config': {'Image': 'old', 'Env': ['OPENRESEARCH_APP_ORIGIN=http://example.test',
                          'MANAGED_CAPACITY=2', 'DATABASE_URL=test-only'], 'Labels': {}},
               'HostConfig': {'ReadonlyRootfs': True, 'CapDrop': ['ALL']}}
        config, host = module.desired_config(old, 'new', 'test-stamp', 2)
        self.assertEqual(config['Env'], old['Config']['Env'])
        self.assertEqual(host, old['HostConfig'])
        self.assertEqual(config['Image'], 'new')


if __name__ == '__main__':
    unittest.main()
