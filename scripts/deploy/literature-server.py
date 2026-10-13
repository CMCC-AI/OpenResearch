#!/usr/bin/env python3
"""Validate on a private clone; install a separate SONA view on the literature host."""
import argparse, hashlib, json, os, pathlib, secrets, subprocess, time, urllib.request, urllib.error, fcntl, socket

ROOT = pathlib.Path('/opt/sona-literature')
PUBLIC = 'http://61.136.101.179:20281'

def run(args, **kw):
    return subprocess.run(args, check=True, **kw)

def sql(container, statement, user='deeplit', database='deeplit'):
    return subprocess.check_output(['docker','exec',container,'psql','-U',user,'-d',database,'-At','-v','ON_ERROR_STOP=1','-c',statement],text=True).strip()

def env_of(name):
    d=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
    return d,dict(x.split('=',1) for x in d['Config']['Env'] if '=' in x)

def snapshot(container):
    return {t:sql(container,"select md5(coalesce(string_agg((to_jsonb(t)-'sso_provider')::text, '' order by (to_jsonb(t)-'sso_provider')::text),'')) from "+t+' t', 'postgres','postgres') for t in ('users','user_identities','user_sessions')}

def validate(bundle, stamp):
    ROOT.mkdir(mode=0o700,exist_ok=True)
    backups=ROOT/'backups';backups.mkdir(mode=0o700,exist_ok=True)
    backup=backups/(stamp+'.dump')
    with backup.open('wb') as f:
        run(['docker','exec','deeplit-db-1','pg_dump','-U','deeplit','-d','deeplit','-Fc'],stdout=f)
    clone='sona-lit-check-'+stamp.lower()
    password=secrets.token_hex(20)
    _, all_env=env_of('deeplit-web-1')
    old_env={k:v for k,v in all_env.items() if k in ('NODE_ENV','DEEPLIT_AUTH_MODE','DEEPLIT_PUBLIC_ORIGIN','DEEPLIT_COOKIE_MODE','DEEPLIT_SECURE_COOKIES','DEEPLIT_DOCKAPI_URL','DEEPLIT_DOCKAPI_PUBLIC_ORIGIN','DEEPLIT_DOCKAPI_APP_ORIGIN')}
    old_env['DEEPLIT_SSO_CLIENT_SECRET']='test-only-clone-sso-secret-32-characters'
    try:
        run(['docker','run','-d','--rm','--name',clone,'-e','POSTGRES_PASSWORD='+password,'postgres:17-alpine'],stdout=subprocess.DEVNULL)
        for _ in range(60):
            if subprocess.run(['docker','exec',clone,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
            time.sleep(1)
        with backup.open('rb') as f:
            run(['docker','exec','-i',clone,'pg_restore','-U','postgres','-d','postgres','--no-owner','--no-privileges'],stdin=f,stdout=subprocess.DEVNULL)
        before=snapshot(clone)
        migration=bundle/'migrations/011_openresearch_sso.sql'
        with migration.open('rb') as f:
            run(['docker','exec','-i',clone,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],stdin=f,stdout=subprocess.DEVNULL)
        if snapshot(clone)!=before:raise RuntimeError('Migration changed existing identities or sessions')
        # Validate old application's public queries against migrated schema.
        old,_=env_of('deeplit-web-1')
        network=json.loads(subprocess.check_output(['docker','inspect',clone]))[0]['NetworkSettings']['Networks']
        ip=next(iter(network.values()))['IPAddress']
        stage='sona-lit-old-check-'+stamp.lower()
        stage_env=ROOT/('check-'+stamp+'.env')
        old_env.update(DATABASE_URL=f'postgres://postgres:{password}@{ip}:5432/postgres',HOSTNAME='0.0.0.0',PORT='3000')
        stage_env.write_text(''.join(k+'='+v+'\n' for k,v in old_env.items() if '\n' not in v));stage_env.chmod(0o600)
        try:
            run(['docker','run','-d','--rm','--name',stage,'--env-file',str(stage_env),old['Image']],stdout=subprocess.DEVNULL)
            check="fetch('http://localhost:3000/api/papers?paginated=1&limit=1').then(async r=>{const d=await r.json();if(!r.ok||!Array.isArray(d.papers))process.exit(1)}).catch(()=>process.exit(1))"
            for i in range(60):
                if subprocess.run(['docker','exec',stage,'node','-e',check],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                if i==59:raise RuntimeError('Old DockAPI web failed migrated-schema smoke test')
                time.sleep(1)
        finally:
            subprocess.run(['docker','stop',stage],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            stage_env.unlink(missing_ok=True)
        candidate_passed=False
        if (bundle/'literature-image.tar').exists():
            run(['docker','load','-i',str(bundle/'literature-image.tar')],stdout=subprocess.DEVNULL)
            image=(bundle/'literature-image-name').read_text().strip()
            candidate='sona-lit-new-check-'+stamp.lower()
            new_env={'NODE_ENV':'production','DATABASE_URL':f'postgres://postgres:{password}@{ip}:5432/postgres','HOSTNAME':'0.0.0.0','PORT':'3000','DEEPLIT_AUTH_MODE':'openresearch','DEEPLIT_OPENRESEARCH_URL':'http://localhost:15300','DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN':PUBLIC,'DEEPLIT_OPENRESEARCH_APP_ORIGIN':PUBLIC,'DEEPLIT_OPENRESEARCH_APP_PATH':'/sona','DEEPLIT_PUBLIC_ORIGIN':PUBLIC,'DEEPLIT_INSECURE_PUBLIC_ORIGIN':PUBLIC,'DEEPLIT_SSO_CLIENT_SECRET':'test-only-candidate-secret-32-characters','DEEPLIT_SECURE_COOKIES':'false'}
            stage_env.write_text(''.join(k+'='+v+'\n' for k,v in new_env.items()));stage_env.chmod(0o600)
            try:
                run(['docker','run','-d','--rm','--name',candidate,'--env-file',str(stage_env),image],stdout=subprocess.DEVNULL)
                check="Promise.all([fetch('http://localhost:3000/api/papers?paginated=1&limit=1').then(async r=>{const d=await r.json();if(!r.ok||!Array.isArray(d.papers))throw Error('papers')}),fetch('http://localhost:3000/api/auth/openresearch/start?returnTo=/library',{redirect:'manual'}).then(r=>{if(r.status!==303||!r.headers.get('location')?.startsWith('http://61.136.101.179:20281/api/auth/sso/authorize?'))throw Error('sso')})]).catch(()=>process.exit(1))"
                for i in range(60):
                    if subprocess.run(['docker','exec',candidate,'node','-e',check],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                    if i==59:raise RuntimeError('Candidate SONA view failed clone public/SSO smoke test')
                    time.sleep(1)
                candidate_passed=True
            finally:
                subprocess.run(['docker','stop',candidate],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                stage_env.unlink(missing_ok=True)
        report={'existingIdentitiesPreserved':True,'oldDockApiPublicQueriesPassed':True,'newSonaViewPassed':candidate_passed,'migrationSha256':hashlib.sha256(migration.read_bytes()).hexdigest(),'backup':str(backup)}
        (backups/(stamp+'.json')).write_text(json.dumps(report,indent=2)+'\n')
        print('Clone migration verified; old DockAPI queries passed. Production unchanged.')
        return migration
    finally:
        subprocess.run(['docker','stop',clone],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def install(bundle, stamp, migration):
    probe=socket.socket(); probe.settimeout(2)
    occupied=probe.connect_ex(('127.0.0.1',3005))==0; probe.close()
    if occupied and subprocess.run(['docker','inspect','sona-literature-web'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0:
        raise RuntimeError('Loopback 3005 belongs to another service')
    state=ROOT/'state';state.mkdir(mode=0o700,exist_ok=True)
    if not (bundle/'literature-image.tar').is_file():raise RuntimeError('Candidate image required before production migration')
    peer=json.loads((bundle/'peer.json').read_text())
    for key in ('ssoSecret','pepper'):
        if not isinstance(peer.get(key),str) or len(peer[key])<32 or '\n' in peer[key]:raise ValueError('Invalid peer secret')
    pub=peer['publicKey'].strip()
    if not pub.startswith('ssh-ed25519 ') or '\n' in pub:raise ValueError('Invalid tunnel key')
    _,old_env=env_of('deeplit-web-1')
    role='sona_literature'
    password_file=state/'database-password'
    if not password_file.exists():password_file.write_text(secrets.token_hex(32))
    password=password_file.read_text().strip()
    # Only the reviewed additive migration is run on the shared database.
    with migration.open('rb') as f:
        run(['docker','exec','-i','deeplit-db-1','psql','-U','deeplit','-d','deeplit','-v','ON_ERROR_STOP=1'],stdin=f,stdout=subprocess.DEVNULL)
    marker=state/'database-role-owned'
    exists=sql('deeplit-db-1',"select count(*) from pg_roles where rolname='sona_literature'")=='1'
    if exists and not marker.exists():raise RuntimeError('Existing database role is not owned by this deployment')
    if not exists:
        statement="CREATE ROLE sona_literature LOGIN PASSWORD '"+password+"';"
        run(['docker','exec','-i','deeplit-db-1','psql','-U','deeplit','-d','deeplit','-v','ON_ERROR_STOP=1'],input=statement.encode(),stdout=subprocess.DEVNULL)
        marker.write_text(role+'\n')
    sql('deeplit-db-1','GRANT CONNECT ON DATABASE deeplit TO sona_literature; GRANT USAGE ON SCHEMA public TO sona_literature; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO sona_literature; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO sona_literature;')
    env={'NODE_ENV':'production','HOSTNAME':'127.0.0.1','PORT':'3005','DATABASE_URL':f'postgres://{role}:{password}@127.0.0.1:5433/deeplit','PAPER_STORAGE_DIR':'/data/papers','DEEPLIT_AUTH_MODE':'openresearch','DEEPLIT_OPENRESEARCH_URL':'http://localhost:15300','DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN':PUBLIC,'DEEPLIT_OPENRESEARCH_APP_ORIGIN':PUBLIC,'DEEPLIT_OPENRESEARCH_APP_PATH':'/sona','DEEPLIT_PUBLIC_ORIGIN':PUBLIC,'DEEPLIT_INSECURE_PUBLIC_ORIGIN':PUBLIC,'DEEPLIT_COOKIE_MODE':'same-site','DEEPLIT_SECURE_COOKIES':'false','DEEPLIT_SSO_CLIENT_SECRET':peer['ssoSecret'],'DEEPLIT_PASSWORD_PEPPER':peer['pepper']}
    for k in ('QWEN_API_KEY','QWEN_BASE_URL','QWEN_MODEL','QWEN_BLOG_MODEL'):
        if old_env.get(k): env[k]=old_env[k]
    envfile=state/'web.env';envfile.write_text(''.join(k+'='+v+'\n' for k,v in env.items()));envfile.chmod(0o600)
    auth=pathlib.Path('/home/ubuntu/.ssh/authorized_keys')
    line='from="61.136.101.179",command="/bin/false",restrict,port-forwarding,permitopen="127.0.0.1:3005",permitlisten="127.0.0.1:15300" '+pub
    current=auth.read_text() if auth.exists() else ''
    if pub.split()[1] not in current:
        auth.parent.mkdir(mode=0o700,exist_ok=True)
        with auth.open('a') as f:f.write(('\n' if current and not current.endswith('\n') else '')+line+'\n')
        run(['chown','ubuntu:ubuntu',str(auth.parent),str(auth)]);auth.chmod(0o600)
    run(['docker','load','-i',str(bundle/'literature-image.tar')],stdout=subprocess.DEVNULL)
    image=(bundle/'literature-image-name').read_text().strip()
    old,_=env_of('deeplit-web-1')
    papers=next(m['Source'] for m in old['Mounts'] if m['Destination']=='/data/papers')
    name='sona-literature-web'
    if subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
        existing=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
        if existing['Config'].get('Labels',{}).get('sona.managed')!='literature':raise RuntimeError('Container name belongs to another service')
        run(['docker','stop',name],stdout=subprocess.DEVNULL);run(['docker','rm',name],stdout=subprocess.DEVNULL)
    run(['docker','run','-d','--name',name,'--label','sona.managed=literature','--memory','1g','--cpus','1','--pids-limit','256','--restart','unless-stopped','--network','host','--env-file',str(envfile),'-v',papers+':/data/papers:ro',image],stdout=subprocess.DEVNULL)
    check="Promise.all([fetch('http://localhost:3005/api/papers?paginated=1&limit=1').then(async r=>{const d=await r.json();if(!r.ok||!Array.isArray(d.papers))throw Error('papers')}),fetch('http://localhost:3005/api/auth/openresearch/start',{redirect:'manual'}).then(r=>{if(r.status!==303)throw Error('sso')})]).catch(()=>process.exit(1))"
    for i in range(60):
        if subprocess.run(['docker','exec',name,'node','-e',check],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
        if i==59:raise RuntimeError('New literature service did not become healthy')
        time.sleep(1)
    print('SONA literature view healthy on loopback 3005; existing services retained.')

if __name__=='__main__':
    os.umask(0o077)
    if os.geteuid()!=0:raise SystemExit('Run via sudo')
    p=argparse.ArgumentParser();p.add_argument('--validate-only',action='store_true');args=p.parse_args()
    ROOT.mkdir(mode=0o700,exist_ok=True)
    lock=(ROOT/'deployment.lock').open('a')
    fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    bundle=pathlib.Path(__file__).resolve().parent
    stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
    migration=validate(bundle,stamp)
    if not args.validate_only:install(bundle,stamp,migration)
