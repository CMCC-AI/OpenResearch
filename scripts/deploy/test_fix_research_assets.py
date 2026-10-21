import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('fix_assets', Path(__file__).with_name('fix-research-assets.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ResearchAssetGatewayTests(unittest.TestCase):
    def test_only_asset_folders_change_and_repeated_runs_are_idempotent(self):
        old = 'server {\n    location /mobilesci/ { proxy_pass http://app/; }\n    location /other/ { proxy_pass http://other/; }\n    location / { return 404; }\n}\n'
        new = module.candidate(old)
        self.assertEqual(new.replace(module.ROUTES, ''), old)
        self.assertEqual(module.candidate(new), new)
        self.assertIn('return 302 /mobilesci$request_uri;', new)
        self.assertIn('Cache-Control "no-store"', new)

    def test_unknown_layout_is_not_modified(self):
        with self.assertRaises(RuntimeError):
            module.candidate('server {}')
        with self.assertRaises(RuntimeError):
            module.candidate('location /research-team/ { proxy_pass http://other; }')

    def test_runtime_and_deployment_templates_keep_the_same_rules(self):
        dedicated = Path(__file__).with_name('nginx.conf').read_text()
        self.assertIn(module.ROUTES, dedicated)
