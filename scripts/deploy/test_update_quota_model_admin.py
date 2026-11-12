import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('quota_admin', Path(__file__).with_name('update-quota-model-admin.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class QuotaAdminDeployment(unittest.TestCase):
    def test_container_and_compose_use_same_platform_only_directory(self):
        source = str(module.DIRECTORY)
        config = {'Image': 'old', 'Env': ['TOKEN_QUOTAS_ENABLED=true', 'TOKEN_QUOTA_MODELS_FILE=/run/mobilesci/token-quota-models.json']}
        host = {'Binds': [source + '/models.json:/run/mobilesci/token-quota-models.json:ro', '/other:/other:ro'], 'ReadonlyRootfs': True}
        updated, mounts = module.desired(config, host, 'new')
        self.assertEqual(updated['Image'], 'new')
        self.assertIn('TOKEN_QUOTAS_ENABLED=true', updated['Env'])
        self.assertIn('TOKEN_QUOTA_MODELS_FILE=' + module.TARGET + '/models.json', updated['Env'])
        self.assertEqual(mounts['Binds'], ['/other:/other:ro', source + ':' + module.TARGET + ':rw'])
        self.assertTrue(mounts['ReadonlyRootfs'])
        compose = {'services': {'platform': {'image': 'old', 'environment': {'TOKEN_QUOTAS_ENABLED': 'true'}, 'volumes': [{'target': '/run/mobilesci/token-quota-models.json', 'source': source + '/models.json', 'read_only': True}]}, 'provisioner': {'image': 'unchanged'}, 'executor': {'volumes': ['/home:/home']}}}
        desired = module.desired_compose(compose, 'new')
        self.assertEqual(desired['services']['platform']['environment']['TOKEN_QUOTA_MODELS_FILE'], module.TARGET + '/models.json')
        self.assertEqual(desired['services']['platform']['volumes'], [{'type': 'bind', 'source': source, 'target': module.TARGET, 'read_only': False}])
        self.assertEqual(desired['services']['provisioner'], compose['services']['provisioner'])
        self.assertEqual(desired['services']['executor'], compose['services']['executor'])
        self.assertEqual(config['Image'], 'old')
        self.assertEqual(compose['services']['platform']['image'], 'old')


if __name__ == '__main__':
    unittest.main()
