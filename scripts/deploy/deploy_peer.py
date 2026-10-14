"""Install the selected literature peer without exporting its database or SSH secrets."""
import json, pathlib, subprocess, tarfile, tempfile, shlex

LITERATURE = 'ubuntu@81.70.174.140'


def deploy_literature_peer(core_ssh, archive, release, manifest):
    peer_ssh = ['ssh', '-o', 'ConnectTimeout=15', LITERATURE]
    subprocess.run(peer_ssh + ['sudo -n true'],check=True)
    with tempfile.TemporaryDirectory(prefix='mobilesci-peer-',dir=archive.parent) as temp:
        folder=pathlib.Path(temp)
        with tarfile.open(archive,'r:gz') as tar:
            for name in ('literature-server.py','literature-image.tar','literature-image-name','migrations/011_openresearch_sso.sql'):
                member=tar.getmember(release+'/'+name)
                target=folder/name;target.parent.mkdir(parents=True,exist_ok=True)
                with tar.extractfile(member) as source, target.open('wb') as out:
                    import shutil
                    shutil.copyfileobj(source,out)
        # The tunnel private key remains on the core server. Only its public half is copied.
        command="sudo -n python3 -c \"import json,pathlib; p=pathlib.Path('/opt/mobilesci/state'); e=dict(x.split('=',1) for x in (p/'.env').read_text().splitlines() if '=' in x); print(json.dumps({'publicKey':(p/'literature-tunnel.pub').read_text(),'ssoSecret':e['DEEPLIT_SSO_CLIENT_SECRET'],'pepper':e['DEEPLIT_PASSWORD_PEPPER']}))\""
        data=json.loads(subprocess.check_output(core_ssh+[command]))
        (folder/'peer.json').write_text(json.dumps(data));(folder/'peer.json').chmod(0o600)
        public_host_key=subprocess.check_output(peer_ssh+['cat /etc/ssh/ssh_host_ed25519_key.pub'],text=True).strip().split()
        if len(public_host_key)<2 or public_host_key[0]!='ssh-ed25519':raise ValueError('Unexpected peer host key')
        remote='.mobilesci-peer-upload/'+release
        subprocess.run(peer_ssh+['umask 077; mkdir -p '+remote+'/migrations'],check=True)
        for name in ('literature-server.py','literature-image.tar','literature-image-name','peer.json','migrations/011_openresearch_sso.sql'):
            subprocess.run(['scp',str(folder/name),LITERATURE+':'+remote+'/'+name],check=True)
        subprocess.run(peer_ssh+[f'sudo -n python3 {remote}/literature-server.py'],check=True)
        known='81.70.174.140 '+public_host_key[0]+' '+public_host_key[1]+'\n'
        install="sudo -n python3 -c "+shlex.quote("from pathlib import Path; p=Path('/opt/mobilesci/state/literature-known-hosts'); p.write_text("+repr(known)+"); p.chmod(0o600)")
        subprocess.run(core_ssh+[install],check=True)
        unit='''[Unit]
Description=MobileSci restricted literature transport
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/ssh -NT -i /opt/mobilesci/state/literature-tunnel -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/opt/mobilesci/state/literature-known-hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:3005:127.0.0.1:3005 -R 127.0.0.1:15300:127.0.0.1:20281 ubuntu@81.70.174.140
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
'''
        write="sudo -n python3 -c "+shlex.quote("from pathlib import Path; Path('/etc/systemd/system/mobilesci-literature-tunnel.service').write_text("+repr(unit)+")")
        subprocess.run(core_ssh+[write],check=True)
        subprocess.run(core_ssh+['sudo -n systemctl daemon-reload && sudo -n systemctl enable --now mobilesci-literature-tunnel.service'],check=True)
