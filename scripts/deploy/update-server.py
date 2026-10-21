import datetime, hashlib, http.client, json, os, pathlib, socket, subprocess, time, urllib.request, urllib.error, urllib.parse, shutil, tempfile, re
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
def historical_migration(candidate, recorded, deployed):
    digest=lambda value: hashlib.sha256(value).hexdigest()
    if digest(candidate)==recorded:
        return candidate
    # Preserve the exact bytes already applied on this server, including an
    # old Windows checkout's CRLF. Never rewrite checksums or accept SQL edits.
    if digest(deployed)!=recorded or candidate.replace(b'\r\n',b'\n')!=deployed.replace(b'\r\n',b'\n'):
        raise RuntimeError('Applied migration content differs; refusing upgrade')
    return deployed
def build_platform(image_id, context, release, container):
    code="const {createPool}=await import('./src/db.mjs');const p=createPool(process.env.DATABASE_URL);try{const r=await p.query('SELECT version,checksum FROM platform_migrations');console.log(JSON.stringify(r.rows))}finally{await p.end()}"
    applied=json.loads(cmd('docker','exec',container,'node','--input-type=module','-e',code,capture=True))
    with tempfile.TemporaryDirectory(prefix='mobilesci-platform-build-') as directory:
        destination=pathlib.Path(directory)/'platform'
        shutil.copytree(context,destination)
        for row in applied:
            version=row['version']
            if not re.fullmatch(r'\d+\.sql',version):raise RuntimeError('Invalid applied migration version')
            file=destination/'migrations'/version
            if not file.is_file():raise RuntimeError('Applied migration missing from update: '+version)
            candidate=file.read_bytes()
            deployed=subprocess.check_output(['docker','exec',container,'cat','/app/platform/migrations/'+version])
            preserved=historical_migration(candidate,row['checksum'],deployed)
            if preserved!=candidate:
                file.write_bytes(preserved)
                print('Preserved applied migration line endings: '+version,flush=True)
        build_service('platform',image_id,destination,release)
def health_headers(service):
    # The local workbench only accepts loopback Host. The account platform
    # validates its configured public Host even for loopback health requests.
    return {'Host':'61.136.101.179:20281'} if service=='platform' else None

def validate_literature_config(config):
    # This deployment serves literature under /deepxiv. A healthy platform with
    # the old root callback still rejects every real literature SSO login.
    env=dict(value.split('=',1) for value in config.get('Env',[]))
    if env.get('DEEPLIT_ORIGIN') and env.get('DEEPLIT_WEB_PATH')!='/deepxiv':
        raise RuntimeError('Literature SSO requires DEEPLIT_WEB_PATH=/deepxiv in the platform and persisted Compose configuration; repair it before upgrading')
def info(name): return json.loads(cmd('docker','inspect',name,capture=True))[0]
def get(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=8) as res: return res.read()
def idle():
    data=json.loads(get('http://127.0.0.1:4791/api/projects/activity'))
    active=sum(row.get('activeAgents',0) for row in data['activity'])
    runs=sum(row.get('runningExperiments',0) for row in data['activity'])
    counts=json.loads(cmd('docker','exec','mobilesci-remote-workbench-1','python3','-c',"import sqlite3,time,json; c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True); print(json.dumps([c.execute('select count(*) from chat_queued_messages').fetchone()[0],c.execute('select count(*) from chat_turn_leases where heartbeat_at > ?', (int(time.time()*1000)-60000,)).fetchone()[0],c.execute(\"select count(*) from chat_spawns where state != 'done'\").fetchone()[0]]))",capture=True))
    queued,leases,dispatches=counts
    # Every private executor is affected by an account gateway restart.
    managed=cmd('docker','ps','-q','--filter','label=openresearch.managed=true',capture=True).split()
    for container in managed:
        detail=info(container)
        if 'src/connector-entry.mjs' in (detail['Config'].get('Cmd') or []): continue
        activity=json.loads(cmd('docker','exec',container,'node','-e',"fetch('http://127.0.0.1:4791/api/projects/activity').then(r=>{if(!r.ok)throw Error('Not ready');return r.json()}).then(d=>console.log(JSON.stringify(d)))",capture=True))
        if any(row.get('activeAgents') or row.get('runningExperiments') for row in activity['activity']): raise RuntimeError('Active private research blocks upgrade')
        pending=json.loads(cmd('docker','exec',container,'python3','-c',"import sqlite3,time,json; c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True); print(json.dumps([c.execute('select count(*) from chat_queued_messages').fetchone()[0],c.execute('select count(*) from chat_turn_leases where heartbeat_at > ?', (int(time.time()*1000)-60000,)).fetchone()[0],c.execute(\"select count(*) from chat_spawns where state != 'done'\").fetchone()[0]]))",capture=True))
        if any(pending): raise RuntimeError('Queued or dispatching private research blocks upgrade')
    print(f'Upgrade admission: active={active}, runs={runs}, queued={queued}, leases={leases}, dispatches={dispatches}',flush=True)
    if active or runs or any(counts): raise RuntimeError('Active or queued research blocks upgrade')

def rehearse_sqlite(old, image):
    relative='state/backups/rehearsal-'+stamp
    script="""import pathlib,sqlite3,json,sys
root=pathlib.Path('/home/node/research')/sys.argv[1]; root.mkdir()
source=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True)
copy=sqlite3.connect(root/'orx.db'); source.backup(copy)
counts={name:copy.execute('SELECT count(*) FROM "'+name.replace('"','""')+'"').fetchone()[0] for name, in copy.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='product_migrations'")}
(root/'before.json').write_text(json.dumps(counts))
"""
    cmd('docker','exec','mobilesci-remote-workbench-1','python3','-c',script,relative)
    mount=next(m for m in old['Mounts'] if m['Destination']=='/home/node/research')
    source=str(pathlib.Path(mount['Source'])/relative)
    subprocess.run(['docker','run','--rm','--network','none','--read-only','--tmpfs','/tmp','--mount','type=bind,source='+source+',target=/rehearsal','--env','ORX_DATA_DIR=/rehearsal','--env','HOME=/tmp','--env','XDG_CONFIG_HOME=/tmp/config','--env','XDG_DATA_HOME=/tmp/data','--entrypoint','/usr/local/bin/orx',image,'--no-telemetry','projects','--json'],stdout=subprocess.DEVNULL,check=True)
    verify="""import pathlib,sqlite3,json,sys
root=pathlib.Path('/home/node/research')/sys.argv[1]
db=sqlite3.connect('file:'+str(root/'orx.db')+'?mode=ro',uri=True)
assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
for name,count in json.loads((root/'before.json').read_text()).items():
 assert db.execute('SELECT count(*) FROM "'+name.replace('"','""')+'"').fetchone()[0]==count, 'Migration changed row count in '+name
print('Research migration rehearsal passed: integrity and existing table counts preserved')
"""
    cmd('docker','exec','mobilesci-remote-workbench-1','python3','-c',verify,relative)

def startup_version(version, restore=False):
    code="""const fs=require('fs');
const file='/release/start.sh',backup=file+'.before-'+process.argv[1];
if(process.argv[3]==='restore'){if(fs.existsSync(backup))fs.copyFileSync(backup,file);}
else{
 const text=fs.readFileSync(file,'utf8'),expression=/d\\.get\\('version'\\)\\s*!=\\s*'[^']+'/g;
 if(!expression.test(text))throw Error('Unknown startup version guard');
 fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
 fs.writeFileSync(file,text.replace(expression,\"d.get('version')!='\"+process.argv[2]+\"'\"));
}
"""
    cmd('docker','run','--rm','--network','none','--user','0','--read-only','--mount','type=bind,source=/opt/mobilesci/current,target=/release','--entrypoint','/usr/local/bin/node','mobilesci-sidebar-platform:'+stamp,'-e',code,stamp,version,'restore' if restore else 'update')
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
validate_literature_config(originals['mobilesci-remote-platform-1']['Config'])
for service,name in services:
    old=originals[name]
    labels=old['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.project')!='mobilesci-remote' or labels.get('com.docker.compose.service')!=service or old['HostConfig']['NetworkMode']!='host':
        raise RuntimeError('Unexpected service configuration; refusing replacement')
    if service=='platform':build_platform(old['Image'],bundle/service,stamp,name)
    else:build_service(service,old['Image'],bundle/service,stamp)
metadata=root/'rollback.json';metadata.write_text(json.dumps(originals));metadata.chmod(0o600)
idle()
rehearse_sqlite(originals['mobilesci-remote-workbench-1'],'mobilesci-sidebar-workbench:'+stamp)
database_backup=root/'platform.dump'
with database_backup.open('xb') as output:
    database_backup.chmod(0o600)
    subprocess.run(['docker','exec','mobilesci-remote-platform-db-1','sh','-c','pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],stdout=output,check=True)
with database_backup.open('rb') as source:
    subprocess.run(['docker','exec','-i','mobilesci-remote-platform-db-1','pg_restore','--list'],stdin=source,stdout=subprocess.DEVNULL,check=True)
print('Platform PostgreSQL backup verified: '+str(database_backup),flush=True)
cmd('docker','exec','mobilesci-remote-workbench-1','python3','-c',f"import pathlib,sqlite3; p=pathlib.Path('/home/node/research/state/backups'); p.mkdir(exist_ok=True); c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True); c.backup(sqlite3.connect(p/'sidebar-{stamp}.db')); print('Research SQLite backup completed')")
idle()
# New additive platform migrations run with the unchanged production environment.
# Keep credentials in a private file rather than command arguments or logs.
environment=root/'platform.env'
environment.write_text('\n'.join(originals['mobilesci-remote-platform-1']['Config']['Env'])+'\n')
environment.chmod(0o600)
try:
    cmd('docker','run','--rm','--network','host','--env-file',str(environment),'--entrypoint','/usr/local/bin/node','mobilesci-sidebar-platform:'+stamp,'/app/platform/src/admin.mjs','migrate')
finally:
    environment.unlink(missing_ok=True)
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
        config['Labels']['sh.mobilesci.source-commit']=manifest.get('commit','unknown')
        config['Labels']['sh.mobilesci.source-fingerprint']=manifest.get('fingerprint','unknown')
        config['Labels']['com.docker.compose.image']=cmd('docker','image','inspect',oldtag,'--format','{{.Id}}',capture=True)
        record['new']=create(name,config,old['HostConfig'])
        cmd('docker','start',name)
        url='http://127.0.0.1:4791/api/health' if service=='workbench' else 'http://127.0.0.1:5300/healthz'
        for attempt in range(60):
            try:
                data=get(url,health_headers(service))
                if service=='workbench' and (not json.loads(data).get('ok') or json.loads(data).get('version')!=manifest.get('version')):raise RuntimeError('Unhealthy or stale workbench')
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
    startup_version(manifest['version'])
    print('DEPLOYMENT COMPLETE: '+stamp,flush=True)
    print('URL: http://61.136.101.179:20281/mobilesci/ ; rollback metadata: '+str(metadata),flush=True)
except BaseException:
    print('Upgrade failed; restoring previous containers',flush=True)
    try:startup_version(manifest.get('version',''),restore=True)
    except Exception:print('Check startup script backup before reboot',flush=True)
    for record in reversed(changed):
        if record['new']:
            subprocess.run(['docker','rm','-f',record['new']],check=False)
        subprocess.run(['docker','rename',record['old']['Id'],record['name']],check=False)
        subprocess.run(['docker','start',record['old']['Id']],check=False)
        service=record['name'].removeprefix('mobilesci-remote-').removesuffix('-1')
        subprocess.run(['docker','tag',record['old']['Image'],record['imageTag']],check=False)
    raise
