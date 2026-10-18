import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('personal_deployment',Path(__file__).with_name('enable-personal-spaces.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PersonalDeploymentTests(unittest.TestCase):
 def test_gateway_is_account_routed_and_preserves_literature_and_static_ui(self):
  text=Path(__file__).with_name('nginx.conf').read_text()
  result=module.gateway_config(text)
  self.assertIn('proxy_pass http://127.0.0.1:5300/api/;',result)
  self.assertIn('proxy_pass http://127.0.0.1:5300;',result)
  self.assertIn('location = /_platform/runner {',result)
  self.assertIn('location /deepxiv/ { proxy_pass http://127.0.0.1:3005; }',result)
  self.assertIn('proxy_pass http://127.0.0.1:4791/;',result)
  self.assertEqual(module.gateway_config(result),result)
 def test_compose_persists_private_flags_and_provisioner_without_plaintext_credentials(self):
  text='name: mobilesci-remote\nservices:\n  platform:\n    image: platform:test\n    environment:\n      DATABASE_URL: postgres://${PASSWORD}@127.0.0.1/db\n  workbench:\n    image: workbench:test\nvolumes:\n  data:\n'
  result=module.compose_config(text,{'PRIVATE_SPACE_ROUTING':'shared-origin'},'platform:test',{'MANAGED_LEGACY_WORKSPACE':'owner-space'})
  self.assertIn('      PRIVATE_SPACE_ROUTING: "shared-origin"',result)
  self.assertIn('  provisioner:',result)
  self.assertIn('postgres://${PASSWORD}@127.0.0.1/db',result)
  self.assertIn('/var/run/docker.sock:/var/run/docker.sock',result)
  with self.assertRaises(ValueError):module.compose_config(result,{},'image',{})
if __name__=='__main__':unittest.main()
