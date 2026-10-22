import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('upload_fix', Path(__file__).with_name('fix-material-upload.py'))
upload_fix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload_fix)


class MaterialUploadDeploymentTests(unittest.TestCase):
    def test_runtime_ownership_excludes_other_projects_and_retained_rollbacks(self):
        item = {'Name': '/orx-managed-owned', 'Config': {'Labels': {'openresearch.managed': 'true', 'openresearch.workspace': 'owned'}}}
        self.assertTrue(upload_fix.owned_runtime(item, {'owned'}))
        self.assertFalse(upload_fix.owned_runtime(item, {'another-project'}))
        item['Name'] += '-rollback'
        self.assertFalse(upload_fix.owned_runtime(item, {'owned'}))
    def test_managed_images_change_without_touching_credentials(self):
        env = {'MANAGED_EXECUTOR_IMAGE': 'executor:old', 'MANAGED_CONNECTOR_IMAGE': 'connector:old', 'TOKEN_FILE': '/private/token'}
        result = upload_fix.source_changes(env, {'executor:old': 'executor:new', 'connector:old': 'connector:new'})
        self.assertEqual(result['MANAGED_EXECUTOR_IMAGE'], 'executor:new')
        self.assertEqual(result['MANAGED_CONNECTOR_IMAGE'], 'connector:new')
        self.assertEqual(result['TOKEN_FILE'], env['TOKEN_FILE'])
        self.assertEqual(env['MANAGED_EXECUTOR_IMAGE'], 'executor:old')

    def test_missing_future_runner_mapping_is_rejected(self):
        with self.assertRaises(RuntimeError):
            upload_fix.source_changes({'MANAGED_EXECUTOR_IMAGE': 'old'}, {'old': 'new'})

    def test_persistence_keeps_other_services_and_volumes(self):
        old = {'services': {'platform': {'image': 'old', 'environment': {'SECRET_FILE': '/private/key'}}, 'provisioner': {'image': 'p', 'environment': {'OTHER': 'keep'}}, 'database': {'image': 'postgres', 'volumes': ['db:/data']}}, 'volumes': {'db': {}}}
        new = upload_fix.desired_compose(old, 'patched', 'original-provisioner', {'MANAGED_EXECUTOR_IMAGE': 'executor:new', 'MANAGED_CONNECTOR_IMAGE': 'connector:new'})
        self.assertEqual(new['services']['platform']['image'], 'patched')
        self.assertEqual(new['services']['platform']['environment'], old['services']['platform']['environment'])
        self.assertEqual(new['services']['database'], old['services']['database'])
        self.assertEqual(new['volumes'], old['volumes'])
        self.assertEqual(new['services']['provisioner']['environment']['OTHER'], 'keep')
        self.assertEqual(old['services']['platform']['image'], 'old')


if __name__ == '__main__':
    unittest.main()
