import datetime, hashlib, http.client, json, os, pathlib, socket, subprocess, time, urllib.request, urllib.error, urllib.parse
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
root=pathlib.Path.home()/('.mobilesci-sidebar-upgrade-'+stamp)
root.mkdir(mode=0o700)
lock_path=pathlib.Path.home()/'.mobilesci-update.lock'
import fcntl
lock=lock_path.open('a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
def cmd(*args, capture=False):
    return subprocess.check_output(args,text=True).strip() if capture else subprocess.run(args,check=True)
def build_service(service, image_id, context, release):
    # Dockerfile FROM interprets a bare sha256 ID as a registry repository.
    # Give the existing daemon image a local tag before resolving the base.
    base='mobilesci-update-base-'+service+':'+release
    cmd('docker','tag',image_id,base)
    cmd('docker','build','--pull=false','--build-arg','BASE_IMAGE='+base,'-t','mobilesci-sidebar-'+service+':'+release,str(context))
def health_headers(service):
    # The local workbench only accepts loopback Host. The account platform
    # validates its configured public Host even for loopback health requests.
    return {'Host':'61.136.101.179:20281'} if service=='platform' else None
def info(name): return json.loads(cmd('docker','inspect',name,capture=True))[0]
def get(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=8) as res: return res.read()
def idle():
    data=json.loads(get('http://127.0.0.1:4791/api/projects/activity'))
    active=sum(row.get('activeAgents',0) for row in data['activity'])
    runs=sum(row.get('runningExperiments',0) for row in data['activity'])
    queued=int(cmd('docker','exec','mobilesci-remote-workbench-1','python3','-c',"import sqlite3; c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True); print(c.execute('select count(*) from chat_queued_messages').fetchone()[0])",capture=True))
    print(f'Upgrade admission: active={active}, runs={runs}, queued={queued}',flush=True)
    if active or runs or queued: raise RuntimeError('Active or queued research blocks upgrade')
class DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')
def create(name,config,hostconfig):
    conn=DockerHTTP('localhost',timeout=30)
    conn.request('POST','/containers/create?name='+urllib.parse.quote(name),json.dumps({'HostConfig':hostconfig,**config}),{'Content-Type':'application/json'})
    res=conn.getresponse(); data=res.read(); conn.close()
    if res.status!=201: raise RuntimeError('Container create failed: '+data.decode())
    return json.loads(data)['Id']
bundle=pathlib.Path(__file__).resolve().parent
manifest=json.loads((bundle/'manifest.json').read_text())
for file,digest in manifest['files'].items():
    path=bundle/file
    if not path.resolve().is_relative_to(bundle) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        raise RuntimeError('Bundle checksum mismatch: '+file)
services=[('workbench','mobilesci-remote-workbench-1'),('platform','mobilesci-remote-platform-1')]
originals={name:info(name) for _,name in services}
for service,name in services:
    old=originals[name]
    labels=old['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project')!='mobilesci-remote' or labels.get('com.docker.compose.service')!=service or old['HostConfig']['NetworkMode']!='host':
        raise RuntimeError('Unexpected service configuration; refusing replacement')
    build_service(service,old['Image'],bundle/service,stamp)
metadata=root/'rollback.json';metadata.write_text(json.dumps(originals));metadata.chmod(0o600)
idle()
cmd('docker','exec','mobilesci-remote-workbench-1','python3','-c',f"import pathlib,sqlite3; p=pathlib.Path('/home/node/research/state/backups'); p.mkdir(exist_ok=True); c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True); c.backup(sqlite3.connect(p/'sidebar-{stamp}.db')); print('Research SQLite backup completed')")
idle()
changed=[]
try:
    for service,name in services:
        old=originals[name]; rollback=name+'-rollback-'+stamp.lower()
        record={'name':name,'old':old,'new':None,'rollback':rollback,'imageTag':old['Config']['Image'] if not old['Config']['Image'].startswith('sha256:') else 'mobilesci-20261013t072430z-bc63f1-'+service+':latest'}; changed.append(record)
        oldtag=old['Config']['Image'] if not old['Config']['Image'].startswith('sha256:') else 'mobilesci-20261013t072430z-bc63f1-'+service+':latest'
        cmd('docker','tag',old['Image'],'mobilesci-sidebar-rollback-'+service+':'+stamp)
        cmd('docker','tag','mobilesci-sidebar-'+service+':'+stamp,oldtag)
        cmd('docker','stop','-t','120',name)
        cmd('docker','rename',name,rollback)
        config=dict(old['Config']);config['Image']=oldtag
        config['Labels']=dict(config.get('Labels') or {})
        config['Labels']['com.docker.compose.image']=cmd('docker','image','inspect',oldtag,'--format','{{.Id}}',capture=True)
        record['new']=create(name,config,old['HostConfig'])
        cmd('docker','start',name)
        url='http://127.0.0.1:4791/api/health' if service=='workbench' else 'http://127.0.0.1:5300/healthz'
        for attempt in range(60):
            try:
                data=get(url,health_headers(service))
                if service=='workbench' and not json.loads(data).get('ok'):raise RuntimeError('Unhealthy workbench')
                break
            except Exception:
                if attempt==59:raise
                time.sleep(1)
        print(service+' upgraded and healthy',flush=True)
    html=get('http://127.0.0.1:20281/mobilesci/',{'Host':'61.136.101.179:20281'}).decode()
    expected=(bundle/'platform/dist/index.html').read_text()
    import re
    for asset in re.findall(r'assets/[^\"\']+\.(?:js|css)', expected):
        if asset not in html:raise RuntimeError('Public page serves stale assets')
        get('http://127.0.0.1:20281/mobilesci/'+asset,{'Host':'61.136.101.179:20281'})
    try:
        get('http://127.0.0.1:20281/mobilesci/api/projects',{'Host':'61.136.101.179:20281'})
    except urllib.error.HTTPError as error:
        if error.code not in (401,403):raise
    else:raise RuntimeError('Anonymous research API unexpectedly accessible')
    print('DEPLOYMENT COMPLETE: '+stamp,flush=True)
    print('URL: http://61.136.101.179:20281/mobilesci/ ; rollback metadata: '+str(metadata),flush=True)
except BaseException:
    print('Upgrade failed; restoring previous containers',flush=True)
    for record in reversed(changed):
        if record['new']:
            subprocess.run(['docker','rm','-f',record['new']],check=False)
        subprocess.run(['docker','rename',record['old']['Id'],record['name']],check=False)
        subprocess.run(['docker','start',record['old']['Id']],check=False)
        service=record['name'].removeprefix('mobilesci-remote-').removesuffix('-1')
        subprocess.run(['docker','tag',record['old']['Image'],record['imageTag']],check=False)
    raise
