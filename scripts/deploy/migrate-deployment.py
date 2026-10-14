"""One-time managed deployment rename; old names are supplied only as migration input."""
import argparse, datetime, fcntl, hashlib, http.client, json, os, pathlib, re, socket, subprocess, time, urllib.request, urllib.parse


def rename_text(text, source, target):
    text=text.replace(source.upper()+'_',target.upper()+'_')
    text=text.replace(source.upper(),'MobileSci' if target=='mobilesci' else target)
    return re.sub(r'(?<![A-Za-z])'+re.escape(source)+r'(?![a-z])',target,text)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--from-name',required=True)
    parser.add_argument('--to-name',default='mobilesci')
    parser.add_argument('--mode',choices=['core','literature'],default='core')
    parser.add_argument('--bundle-dir',type=pathlib.Path)
    parser.add_argument('--literature-image')
    args=parser.parse_args(); old,new=args.from_name,args.to_name
    if not all(re.fullmatch('[a-z][a-z0-9-]{1,30}',x) for x in [old,new]) or old==new:raise ValueError('Invalid migration names')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder=pathlib.Path.home()/('.'+new+'-migration-'+stamp);folder.mkdir(mode=0o700)
    lock=(pathlib.Path.home()/('.'+new+'-migration.lock')).open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    def cmd(*values,capture=False):
        return subprocess.check_output(values,text=True).strip() if capture else subprocess.run(values,check=True)
    class Docker(http.client.HTTPConnection):
        def connect(self):
            self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.connect('/var/run/docker.sock')
    def api(method,path,payload=None):
        conn=Docker('localhost',timeout=90);conn.request(method,path,None if payload is None else json.dumps(payload),{'Content-Type':'application/json'})
        result=conn.getresponse();body=result.read();conn.close()
        if result.status>=400:raise RuntimeError('Docker '+method+' '+path+' failed: '+str(result.status))
        return json.loads(body) if body else None
    def inspect(name):return json.loads(cmd('docker','inspect',name,capture=True))[0]
    def fetch_http(url,headers=None):
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=5) as res:return res.read()
    names=[old+'-literature-web'] if args.mode=='literature' else [old+'-remote-'+service+'-1' for service in ['workbench','platform','gateway','platform-db']]
    original={name:inspect(name) for name in names}
    snapshot=folder/'containers.json';snapshot.write_text(json.dumps(original));snapshot.chmod(0o600)
    helper=original[names[0]]['Image']
    def systemctl(*values):
        cmd('docker','run','--rm','--pid=host','--user','0','--entrypoint','/host-lib/ld-linux-x86-64.so.2','--mount','type=bind,src=/usr/bin/systemctl,dst=/host-systemctl,readonly','--mount','type=bind,src=/lib/x86_64-linux-gnu,dst=/host-lib,readonly','--mount','type=bind,src=/run/systemd/private,dst=/run/systemd/private','--mount','type=bind,src=/run/systemd/system,dst=/run/systemd/system,readonly','--mount','type=bind,src=/etc/systemd/system,dst=/etc/systemd/system',helper,'--library-path','/host-lib','/host-systemctl',*values)
    def idle():
        if args.mode!='core':return
        rows=json.loads(fetch_http('http://127.0.0.1:4791/api/projects/activity'))['activity']
        counts=[sum(x.get(field,0) for x in rows) for field in ['activeAgents','runningExperiments']]
        queued=int(cmd('docker','exec',names[0],'python3','-c',"import sqlite3;c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True);print(c.execute('select count(*) from chat_queued_messages').fetchone()[0])",capture=True))
        print('Migration admission counts:',*counts,queued,flush=True)
        if any(counts) or queued:raise RuntimeError('Active or queued research blocks migration')
    idle()
    images={}
    if args.mode=='core':
        bundle=args.bundle_dir.resolve();manifest=json.loads((bundle/'manifest.json').read_text())
        for name,digest in manifest['files'].items():
            path=(bundle/name).resolve()
            if not path.is_relative_to(bundle) or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise RuntimeError('Bundle checksum mismatch')
        for service in ['workbench','platform']:
            base=new+'-migration-base-'+service+':'+stamp
            cmd('docker','tag',original[old+'-remote-'+service+'-1']['Image'],base)
            image=new+'-migration-'+service+':'+stamp
            cmd('docker','build','--pull=false','--build-arg','BASE_IMAGE='+base,'-t',image,str(bundle/service));images[service]=image
        cmd('docker','exec',names[0],'python3','-c',f"import pathlib,sqlite3;p=pathlib.Path('/home/node/research/state/backups');p.mkdir(exist_ok=True);sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True).backup(sqlite3.connect(p/'brand-{stamp}.db'));print('Research backup complete')")
        db=original[names[-1]];env=dict(x.split('=',1) for x in db['Config']['Env']);backup=folder/'platform.sql'
        with backup.open('w') as out:subprocess.run(['docker','exec',names[-1],'pg_dumpall','-U',env.get('POSTGRES_USER','research_platform')],stdout=out,check=True)
        backup.chmod(0o600)
    if args.mode=='literature' and args.literature_image:
        cmd('docker','image','inspect',args.literature_image,capture=True)
        images['literature']=args.literature_image
    systemctl('show','--property=Version')
    units=[] if args.mode=='literature' else [old+'.service',old+'-literature-tunnel.service']
    host_script=r'''
const fs=require('fs'),path=require('path');const [old,newName,folder,mode]=process.argv.slice(1);
const replace=s=>s.replaceAll(old.toUpperCase()+'_',newName.toUpperCase()+'_').replaceAll(old.toUpperCase(),'MobileSci').replace(new RegExp('(?<![A-Za-z])'+old+'(?![a-z])','g'),newName);
const journalFile=path.join(folder,'host-journal.json');let journal={dirs:[],files:[],links:[]};
const save=()=>fs.writeFileSync(journalFile,JSON.stringify(journal),{mode:0o600});
function edit(file){if(!fs.existsSync(file))return;let s=fs.readFileSync(file,'utf8'),n=path.basename(file)==='.env'?s.split('\n').map(line=>/(PASSWORD|SECRET|TOKEN|PEPPER)=/.test(line)?line:replace(line)).join('\n'):replace(s);if(path.basename(file)==='nginx.conf')n=n.replace(/    location \/ \{\n(?:        [^\n]*\n)+    \}/g,'    location / { return 404; }');if(s!==n){journal.files.push({file,data:Buffer.from(s).toString('base64')});save();fs.writeFileSync(file,n);}}
function walk(dir){if(!fs.existsSync(dir))return;for(const ent of fs.readdirSync(dir,{withFileTypes:true})){let file=path.join(dir,ent.name);if(ent.isSymbolicLink()){const s=fs.readlinkSync(file),n=replace(s);if(s!==n){journal.links.push({file,target:s});save();fs.unlinkSync(file);fs.symlinkSync(n,file);}}else if(ent.isDirectory()){if(!['research','opencode','opencode-auth','backups'].includes(ent.name))walk(file);}else if(ent.name==='.env'||/\.(yaml|yml|sh|conf|service)$/.test(ent.name))edit(file);}}
const roots=mode==='literature'?['/opt/'+old+'-literature']:['/opt/'+old];
for(const from of roots){const to=replace(from);if(fs.existsSync(from)){if(fs.existsSync(to))throw Error('Target directory exists: '+to);journal.dirs.push({from,to});save();fs.renameSync(from,to);walk(to);}}
for(const ent of fs.readdirSync('/home/ubuntu')){if(ent.startsWith('.'+old+'-')){const from='/home/ubuntu/'+ent,to=replace(from);if(fs.existsSync(to))throw Error('Target exists: '+to);journal.dirs.push({from,to});save();fs.renameSync(from,to);if(ent.includes('root-fix'))walk(to);}}
if(mode==='core'){
 const system='/etc/systemd/system';for(const ent of fs.readdirSync(system)){if(ent.startsWith(old)&&ent.endsWith('.service')){const from=path.join(system,ent),to=replace(from);journal.dirs.push({from,to});save();fs.renameSync(from,to);edit(to);}}
 for(const dir of fs.readdirSync(system)){const full=path.join(system,dir);if(dir.endsWith('.wants')&&fs.statSync(full).isDirectory())for(const ent of fs.readdirSync(full)){if(ent.startsWith(old)){const from=path.join(full,ent),to=replace(from),target=fs.readlinkSync(from);journal.dirs.push({from,to});save();fs.renameSync(from,to);journal.links.push({file:to,target});save();fs.unlinkSync(to);fs.symlinkSync(replace(target),to);}}}
 edit('/opt/cmcc-apps/config/gateway-nginx.conf');
}
save();console.log('Host deployment names migrated');
'''
    restore_script=r'''const fs=require('fs'),path=require('path');const file=path.join(process.argv[1],'host-journal.json');if(fs.existsSync(file)){const j=JSON.parse(fs.readFileSync(file));for(const x of j.files.reverse())fs.writeFileSync(x.file,Buffer.from(x.data,'base64'));for(const x of j.links.reverse()){if(fs.existsSync(x.file)||fs.lstatSync(path.dirname(x.file)).isDirectory()){try{fs.unlinkSync(x.file)}catch{}fs.symlinkSync(x.target,x.file)}}for(const x of j.dirs.reverse())fs.renameSync(x.to,x.from);console.log('Host files restored');}'''
    def host_node(code,*values):
        cmd('docker','run','--rm','--user','0','--entrypoint','node','--mount','type=bind,src=/opt,dst=/opt','--mount','type=bind,src=/home/ubuntu,dst=/home/ubuntu','--mount','type=bind,src=/etc/systemd/system,dst=/etc/systemd/system',helper,'-e',code,*values)
    changes=[];host_changed=False;role_change=None
    try:
        idle()
        for unit in units:systemctl('stop',unit)
        for name in names:
            cmd('docker','stop','-t','120',name)
        host_changed=True;host_node(host_script,old,new,str(folder),args.mode)
        volumes={}
        for item in original.values():
            for mount in item['Mounts']:
                if mount['Type']=='volume' and mount['Name'].startswith(old+'-'):
                    name=mount['Name'];target=rename_text(name,old,new)
                    if target not in volumes.values():
                        if subprocess.run(['docker','volume','inspect',target],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise RuntimeError('Target volume already exists')
                        cmd('docker','volume','create','--label','com.docker.compose.project='+new+'-remote','--label','com.docker.compose.volume='+target.split('_',1)[-1],target)
                        cmd('docker','run','--rm','--user','0','--entrypoint','sh','--mount','type=volume,src='+name+',dst=/from,readonly','--mount','type=volume,src='+target+',dst=/to',helper,'-ec','cp -a /from/. /to/')
                    volumes[name]=target
        networks={}
        for item in original.values():
            network=item['HostConfig']['NetworkMode']
            if network.startswith(old+'-') and network not in networks:
                target=rename_text(network,old,new);cmd('docker','network','create','--label','com.docker.compose.project='+new+'-remote','--label','com.docker.compose.network=default',target);networks[network]=target
        if args.mode=='literature':
            env=dict(x.split('=',1) for x in original[names[0]]['Config']['Env']);uri=urllib.parse.urlsplit(env['DATABASE_URL']);role=uri.username
            if role.startswith(old+'_'):
                target=rename_text(role,old,new)
                if not all(re.fullmatch('[a-z_]+',x) for x in [role,target]):raise RuntimeError('Unexpected role name')
                # PostgreSQL 17 deployment uses SCRAM passwords; preserve them.
                md5=cmd('docker','exec','deeplit-db-1','psql','-U','deeplit','-d','deeplit','-Atc',"select coalesce(rolpassword like 'md5%',false) from pg_authid where rolname='"+role+"'",capture=True)
                if md5=='t':raise RuntimeError('MD5 role requires a dedicated password migration')
                cmd('docker','exec','deeplit-db-1','psql','-U','deeplit','-d','deeplit','-v','ON_ERROR_STOP=1','-c','ALTER ROLE '+role+' RENAME TO '+target);role_change=(role,target)
        # Database first; gateway last. Keep original stopped containers for rollback.
        order=list(reversed(names)) if args.mode=='core' else names
        if args.mode=='core':order=[names[-1],names[1],names[0],names[2]]
        for name in order:
            item=original[name];service=name.removeprefix(old+'-remote-').removesuffix('-1') if args.mode=='core' else 'literature'
            target=rename_text(name,old,new);archive=new+'-before-rename-'+service+'-'+stamp
            cmd('docker','rename',name,archive)
            config=dict(item['Config']);host=dict(item['HostConfig'])
            config['Env']=[rename_text(value,old,new) if not re.search(r'(PASSWORD|SECRET|TOKEN|PEPPER|KEY)=',value) else value for value in config['Env']]
            config['Labels']={k:rename_text(v,old,new) for k,v in (config.get('Labels') or {}).items()}
            for key in ['Cmd','Entrypoint']:
                if config.get(key):config[key]=[rename_text(v,old,new) for v in config[key]]
            host['Binds']=[rename_text(v,old,new) for v in (host.get('Binds') or [])]
            if host.get('Mounts'):
                host['Mounts']=json.loads(rename_text(json.dumps(host['Mounts']),old,new))
            host['NetworkMode']=networks.get(host['NetworkMode'],host['NetworkMode'])
            image=images.get(service,item['Image'])
            release=pathlib.Path(original[names[0]]['Config'].get('Labels',{}).get('com.docker.compose.project.config_files','/releases/'+stamp+'/compose.yaml')).parent.name
            image_tag=new+'-'+release.lower()+'-'+({'gateway':'nginx','platform-db':'postgres'}.get(service,service))+':latest'
            cmd('docker','tag',image,image_tag);config['Image']=image_tag
            config['Labels']['com.docker.compose.image']=cmd('docker','image','inspect',image_tag,'--format','{{.Id}}',capture=True)
            payload={**config,'HostConfig':host}
            created=api('POST','/containers/create?name='+target,payload)['Id'];changes.append((item['Id'],created,name,target));cmd('docker','start',created)
        if args.mode=='core':
            cmd('docker','exec','cmcc-apps-gateway-1','nginx','-t');cmd('docker','exec','cmcc-apps-gateway-1','nginx','-s','reload')
            systemctl('daemon-reload')
            for unit in units:systemctl('enable',rename_text(unit,old,new))
            systemctl('start',new+'-literature-tunnel.service')
            systemctl('start',new+'.service')
        if args.mode=='core':
            for probe,headers in [('http://127.0.0.1:4791/api/health',None),('http://127.0.0.1:5300/healthz',{'Host':'61.136.101.179:20281'})]:
                for attempt in range(60):
                    try:fetch_http(probe,headers);break
                    except Exception:
                        if attempt==59:raise
                        time.sleep(1)
        url='http://127.0.0.1:20281/'+new+'/' if args.mode=='core' else 'http://127.0.0.1:3005/deepxiv/api/papers?paginated=1&limit=1'
        for attempt in range(60):
            try:
                body=fetch_http(url,{'Host':'61.136.101.179:20281'})
                if args.mode=='core' and b'MobileSci' not in body:raise RuntimeError('Brand validation failed')
                break
            except Exception:
                if attempt==59:raise
                time.sleep(2)
        print('MIGRATION COMPLETE:',args.mode,'; snapshots:',folder,flush=True)
    except BaseException:
        print('Migration failed; restoring original deployment',flush=True)
        for _,created,_,_ in reversed(changes):subprocess.run(['docker','rm','-f',created],check=False)
        if role_change:
            subprocess.run(['docker','exec','deeplit-db-1','psql','-U','deeplit','-d','deeplit','-c','ALTER ROLE '+role_change[1]+' RENAME TO '+role_change[0]],check=False)
        if host_changed:host_node(restore_script,str(folder))
        for name,item in original.items():
            subprocess.run(['docker','rename',item['Id'],name],check=False);subprocess.run(['docker','start',item['Id']],check=False)
        if args.mode=='core':
            subprocess.run(['docker','exec','cmcc-apps-gateway-1','nginx','-s','reload'],check=False)
            systemctl('daemon-reload')
            for unit in units:systemctl('start',unit)
        raise


if __name__=='__main__':main()
