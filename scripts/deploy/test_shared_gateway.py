import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('shared_gateway',Path(__file__).with_name('shared-gateway.py'))
gateway=importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class SharedGatewayTests(unittest.TestCase):
    def setup_gateway(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        config=Path(temp.name)/'gateway-nginx.conf'
        original='''server {
    location /research/ { proxy_pass http://research_upstream/; }
    location = / {
        return 200 "existing apps";
    }
    location / { return 404; }
}
'''
        config.write_text(original)
        info={'Mounts':[{'Source':str(config),'Destination':'/etc/nginx/conf.d/default.conf'}], 'NetworkSettings':{'Networks':{'cmcc-apps_doclens':{'Gateway':'172.18.0.1'}}}}
        return config,original,info

    def test_routes_preserved_and_second_run_is_idempotent(self):
        config,original,info=self.setup_gateway()
        def run(args,**kwargs):
            return subprocess.CompletedProcess(args,0,json.dumps([info]) if args[1]=='inspect' else '')
        with patch.object(gateway.pathlib,'Path',return_value=config),patch.object(gateway.subprocess,'run',side_effect=run) as calls:
            gateway.configure()
            rendered=config.read_text()
            self.assertIn('location /research/ { proxy_pass http://research_upstream/; }',rendered)
            self.assertIn('proxy_pass http://172.18.0.1:20281;',rendered)
            self.assertIn('if ($arg_continue != "")',rendered)
            self.assertIn('if ($http_host != "61.136.101.179:20281")',rendered)
            self.assertIn('return 200 "existing apps";',rendered)
            self.assertIn('location ^~ /research-experts/', rendered)
            self.assertIn('location ^~ /research-team/', rendered)
            self.assertIn('return 302 /mobilesci$request_uri;', rendered)
            self.assertEqual(len(list(config.parent.glob('*.mobilesci-backup-*'))),1)
            gateway.configure()
            self.assertEqual(config.read_text(),rendered)
            self.assertEqual(sum(c.args[0][-2:]==['-s','reload'] for c in calls.call_args_list),1)

    def test_existing_mobilesci_routes_gain_public_literature_homepage(self):
        config,original,info=self.setup_gateway()
        old=original.replace('    location / { return 404; }',
            '    # MobileSci shared gateway routes\n    location /mobilesci/ { proxy_pass http://172.18.0.1:20281; }\n    location / { return 404; }')
        config.write_text(old)
        def run(args,**kwargs):
            return subprocess.CompletedProcess(args,0,json.dumps([info]) if args[1]=='inspect' else '')
        with patch.object(gateway.pathlib,'Path',return_value=config),patch.object(gateway.subprocess,'run',side_effect=run):
            gateway.configure()
        new=config.read_text()
        self.assertEqual(new.count('location /mobilesci/'),1)
        self.assertIn('if ($http_host != "61.136.101.179:20281")',new)
        self.assertIn('return 200 "existing apps";',new)
        self.assertIn('location /research/',new)

    def test_invalid_nginx_config_restores_original(self):
        config,original,info=self.setup_gateway()
        def run(args,**kwargs):
            if args[-1]=='-t':raise subprocess.CalledProcessError(1,args)
            return subprocess.CompletedProcess(args,0,json.dumps([info]) if args[1]=='inspect' else '')
        with patch.object(gateway.pathlib,'Path',return_value=config),patch.object(gateway.subprocess,'run',side_effect=run):
            with self.assertRaises(subprocess.CalledProcessError):gateway.configure()
        self.assertEqual(config.read_text(),original)

    def test_unknown_mount_is_not_modified(self):
        config,original,info=self.setup_gateway();info['Mounts']=[]
        with patch.object(gateway.pathlib,'Path',return_value=config),patch.object(gateway.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps([info]))):
            with self.assertRaises(SystemExit):gateway.configure()
        self.assertEqual(config.read_text(),original)


if __name__=='__main__':unittest.main()
