"""Replace only a managed MobileSci service while preserving its runtime configuration."""
import argparse,http.client,socket,json,pathlib,subprocess,time,urllib.request,datetime

class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')

def api(method,path,data=None):
    conn=DockerConnection('localhost')
    conn.request(method,path,body=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
    result=conn.getresponse();body=result.read();conn.close()
    if result.status>=400:raise RuntimeError(f'Docker operation {method} failed with status {result.status}')
    return json.loads(body) if body else None

def replace(name,image,env):
    if name not in ('mobilesci-remote-platform-1','mobilesci-literature-web'):raise ValueError('Unmanaged service name')
    info=api('GET',f'/containers/{name}/json');labels=info['Config'].get('Labels') or {}
    if name=='mobilesci-literature-web':assert labels.get('mobilesci.managed')=='literature'
    else:assert labels.get('com.docker.compose.project')=='mobilesci-remote' and labels.get('com.docker.compose.service')=='platform'
    assert info['HostConfig']['NetworkMode']=='host'
    image_info=json.loads(subprocess.check_output(['docker','image','inspect',image]))[0]
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder=pathlib.Path.home()/'.mobilesci-service-rollbacks';folder.mkdir(mode=0o700,exist_ok=True)
    record=folder/(name+'-'+stamp+'.json');record.write_text(json.dumps(info));record.chmod(0o600)
    config=info['Config'];config['Image']=image_info['Id'];config['Cmd']=image_info['Config']['Cmd'];config['Entrypoint']=image_info['Config'].get('Entrypoint')
    config['HostConfig']=info['HostConfig']
    values=dict(v.split('=',1) for v in config['Env'])
    for value in env:
        key,val=value.split('=',1)
        if key!='DEEPLIT_WEB_PATH' or val!='/deepxiv':raise ValueError('Unsupported environment override')
        values[key]=val
    config['Env']=[k+'='+v for k,v in values.items()]
    if name=='mobilesci-remote-platform-1':config['Labels']['com.docker.compose.image']=image_info['Id']
    candidate=name+'-candidate-'+stamp;backup=name+'-backup-'+stamp
    api('POST','/containers/create?name='+candidate,config)
    api('POST','/containers/'+name+'/stop?t=10');api('POST','/containers/'+name+'/rename?name='+backup)
    try:
        api('POST','/containers/'+candidate+'/rename?name='+name);api('POST','/containers/'+name+'/start')
        url='http://127.0.0.1:5300/healthz' if name=='mobilesci-remote-platform-1' else 'http://127.0.0.1:3005/deepxiv/api/papers?paginated=1&limit=1'
        for attempt in range(45):
            try:
                with urllib.request.urlopen(urllib.request.Request(url,headers={'Host':'61.136.101.179:20281'}),timeout=3) as response:
                    data=json.load(response)
                    assert response.status==200
                    assert data.get('ok') if name=='mobilesci-remote-platform-1' else isinstance(data.get('papers'),list)
                break
            except Exception:
                if attempt==44:raise RuntimeError('Service health timeout')
                time.sleep(1)
    except BaseException:
        api('POST','/containers/'+name+'/stop?t=10');api('DELETE','/containers/'+name)
        api('POST','/containers/'+backup+'/rename?name='+name);api('POST','/containers/'+name+'/start')
        raise
    print('Service healthy:',name,'; retained rollback container:',backup)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('name');parser.add_argument('image');parser.add_argument('--env',action='append',default=[])
    args=parser.parse_args();replace(args.name,args.image,args.env)
