"""Activate account-owned research behind the existing MobileSci origin.

Run only after update-server.py succeeds. Keeps the original workbench and its
data for the existing research owner; new users receive separate Docker homes.
"""
import argparse
import datetime
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request


def run(*args, capture=False, **kwargs):
    if capture:
        return subprocess.check_output(args, text=True, **kwargs).strip()
    subprocess.run(args, check=True, **kwargs)


def inspect(name):
    return json.loads(run('docker', 'inspect', name, capture=True))[0]


def replace_location(text, name, replacement):
    start = text.index('location ' + name + ' {')
    opening = text.index('{', start)
    depth = 1
    end = opening + 1
    while depth and end < len(text):
        depth += (text[end] == '{') - (text[end] == '}')
        end += 1
    if depth:
        raise ValueError('Invalid gateway location: ' + name)
    return text[:start] + replacement + text[end:]


def gateway_config(text):
    for location, upstream in [('/mobilesci/api/', '/api/'), ('/api/', '')]:
        text = replace_location(text, location, '''location %s {
        if ($mobilesci_csrf_allowed = 0) { return 403; }
        proxy_set_header Host 61.136.101.179:20281;
        proxy_set_header Origin $http_origin;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $mobilesci_connection_upgrade;
        proxy_pass http://127.0.0.1:5300%s;
    }''' % (location, upstream))
    if 'location = /_platform/runner {' not in text:
        marker = '    location = /_account/login'
        if marker not in text:
            raise ValueError('Unknown gateway configuration')
        text = text.replace(marker, '''    location = /_platform/runner {
        proxy_set_header Host 61.136.101.179:20281;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $mobilesci_connection_upgrade;
        proxy_pass http://127.0.0.1:5300;
    }
''' + marker, 1)
    return text


def compose_config(text, env, platform_image, provisioner_env):
    if '  provisioner:' in text:
        raise ValueError('Provisioner already configured; use its existing deployment')
    start = text.index('  platform:\n')
    # Locate the next service, not a child field.
    end = re.search(r'\n  [a-z][a-z-]*:\n', text[start + 3:])
    end = start + 3 + end.start() if end else len(text)
    block = text[start:end]
    additions = ''.join('      %s: "%s"\n' % (key, value) for key, value in env.items())
    block = block.replace('    environment:\n', '    environment:\n' + additions, 1)
    text = text[:start] + block + text[end:]
    database = re.search(r'^      DATABASE_URL: (.+)$', block, re.MULTILINE)
    if not database:
        raise ValueError('Platform database environment missing')
    service = '''  provisioner:
    image: %s
    network_mode: host
    user: "0:0"
    command: [node, src/provisioner.mjs]
    environment:
      DATABASE_URL: %s
%s    volumes: [/var/run/docker.sock:/var/run/docker.sock]
    labels: {openresearch.provisioner: "true"}
    restart: unless-stopped
    read_only: true
    init: true
''' % (platform_image, database.group(1), ''.join('      %s: %s\n' % (k, json.dumps(v)) for k, v in provisioner_env.items()))
    return text.replace('\nvolumes:\n', '\n' + service + 'volumes:\n', 1)


class DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def create(name, config, hostconfig):
    conn = DockerHTTP('localhost', timeout=30)
    conn.request('POST', '/containers/create?name=' + name,
                 json.dumps({'HostConfig': hostconfig, **config}),
                 {'Content-Type': 'application/json'})
    response = conn.getresponse()
    data = response.read()
    conn.close()
    if response.status != 201:
        raise RuntimeError('Container creation failed')
    return json.loads(data)['Id']


def main(package, capacity):
    import fcntl
    lock=(Path.home()/'.mobilesci-update.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    root = Path.home() / ('.mobilesci-personal-upgrade-' + stamp)
    root.mkdir(mode=0o700)
    platform = 'mobilesci-remote-platform-1'
    gateway = 'mobilesci-remote-gateway-1'
    old = inspect(platform)
    existing = dict(entry.split('=', 1) for entry in old['Config']['Env'])
    if existing.get('PRIVATE_SPACE_ROUTING') == 'shared-origin':
        print('Personal routing already enabled; no deployment changes', flush=True)
        return
    if old['HostConfig']['NetworkMode'] != 'host':
        raise RuntimeError('Unexpected platform network')
    activity = json.loads(urllib.request.urlopen('http://127.0.0.1:4791/api/projects/activity', timeout=10).read())
    if any(row.get('activeAgents') or row.get('runningExperiments') for row in activity['activity']):
        raise RuntimeError('Active research blocks routing activation')
    with (root / 'platform.dump').open('xb') as output:
        os.chmod(output.name, 0o600)
        run('docker', 'exec', 'mobilesci-remote-platform-db-1', 'sh', '-c',
            'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc', stdout=output)
    (root / 'platform.before.json').write_text(json.dumps(old))
    os.chmod(root / 'platform.before.json', 0o600)
    nginx = run('docker', 'exec', gateway, 'cat', '/etc/nginx/conf.d/default.conf', capture=True) + '\n'
    (root / 'nginx.before.conf').write_text(nginx)
    run('docker', 'exec', platform, 'node', 'src/admin.mjs', 'ensure-personal-spaces')
    owner = existing['PLATFORM_RESEARCH_OWNER_EMAIL']
    workspace = run('docker', 'exec', platform, 'node', 'src/admin.mjs',
                    'prepare-personal-space', owner, capture=True)
    if not re.fullmatch('[0-9a-f-]{36}', workspace):
        raise RuntimeError('Unexpected original owner space')
    executor_image = 'mobilesci-personal-executor:' + stamp
    with tempfile.TemporaryDirectory(prefix='personal-executor-') as temporary:
        context = Path(temporary)
        for name in ['src', 'node_modules']:
            shutil.copytree(package / 'platform' / name, context / name)
        (context / 'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\nUSER root\nWORKDIR /app/platform\nCOPY src ./src\nCOPY node_modules ./node_modules\nUSER node\nCMD ["node","src/executor-entry.mjs"]\n')
        run('docker', 'build', '--pull=false', '--build-arg',
            'BASE_IMAGE=' + inspect('mobilesci-remote-workbench-1')['Config']['Image'],
            '-t', executor_image, str(context))
    changes = {'PRIVATE_USER_SPACES': 'true', 'MANAGED_EXECUTORS': 'true',
               'PRIVATE_SPACE_ROUTING': 'shared-origin', 'MANAGED_CAPACITY': str(capacity)}
    provisioner_env = {
        'PLATFORM_ORIGIN': existing['PLATFORM_ORIGIN'],
        'MANAGED_CONNECT_URL': 'http://host.docker.internal:20281',
        'MANAGED_LEGACY_CONNECT_URL': 'http://127.0.0.1:5300',
        'MANAGED_EXECUTOR_IMAGE': executor_image,
        'MANAGED_CONNECTOR_IMAGE': old['Config']['Image'],
        'MANAGED_LEGACY_WORKSPACE': workspace,
        'MANAGED_OPENCODE_CONFIG_DIR': '/opt/mobilesci/state/opencode',
        'MANAGED_OPENCODE_AUTH_FILE': '/opt/mobilesci/state/opencode-auth/auth.json',
        'ORX_DEEP_LITERATURE_URL': 'http://host.docker.internal:20281',
        'ORX_DEEP_LITERATURE_WEB_URL': existing['PLATFORM_ORIGIN'],
    }
    # Read/write the fixed release directory through a narrowly scoped root helper.
    image = old['Config']['Image']
    def release_file(name, value=None):
        script = "const fs=require('fs');const p='/release/'+process.argv[1];" + (
            "fs.writeFileSync(p,process.argv[2]);" if value is not None else "process.stdout.write(fs.readFileSync(p,'utf8'));"
        )
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0',
                '--mount', 'type=bind,source=/opt/mobilesci/current,target=/release',
                '--entrypoint', '/usr/local/bin/node', image, '-e', script, name]
        if value is not None:
            args.append(value)
        return run(*args, capture=True)
    compose = release_file('compose.yaml')
    (root / 'compose.before.yaml').write_text(compose)
    os.chmod(root / 'compose.before.yaml', 0o600)
    desired_compose = compose_config(compose, changes, image, provisioner_env)
    desired_gateway = gateway_config(nginx)
    candidate=root/'compose.validate.yaml'
    candidate.write_text(desired_compose)
    dummy={name:'validation-only' for name in re.findall(r'\$\{([A-Z_0-9]+)',desired_compose)}
    run('docker','compose','--env-file','/dev/null','-f',str(candidate),'config','--quiet',env={**os.environ,**dummy})
    candidate.unlink()
    environment = root / 'provisioner.env'
    environment.write_text('\n'.join(k + '=' + v for k, v in {
        **provisioner_env, 'DATABASE_URL': existing['DATABASE_URL']}.items()) + '\n')
    os.chmod(environment, 0o600)
    rollback = platform + '-before-personal-' + stamp.lower()
    provisioner = 'mobilesci-remote-provisioner-1'
    created = None
    switched = False
    provisioner_created = False
    previous_provisioner = None
    matches=run('docker','ps','-aq','--filter','name=^/'+provisioner+'$',capture=True)
    if matches:
        prior=inspect(provisioner)
        if prior['Config'].get('Labels',{}).get('openresearch.provisioner')!='true':
            raise RuntimeError('Unrecognized provisioner container')
        previous_provisioner=(provisioner+'-before-'+stamp.lower(),prior['State']['Running'])
        run('docker','stop',provisioner)
        run('docker','rename',provisioner,previous_provisioner[0])
    try:
        run('docker', 'run', '-d', '--name', provisioner, '--network', 'host', '--user', '0',
            '--read-only', '--init', '--restart', 'unless-stopped', '--env-file', str(environment),
            '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
            '--label', 'com.docker.compose.project=mobilesci-remote',
            '--label', 'com.docker.compose.service=provisioner',
            '--label', 'com.docker.compose.container-number=1',
            '--label', 'com.docker.compose.oneoff=False',
            '--label', 'openresearch.provisioner=true', image, 'node', 'src/provisioner.mjs')
        provisioner_created=True
        # Fail closed: remove direct access to shared research before admitting
        # ordinary accounts. Never enable private identities behind the old proxy.
        release_file('nginx.conf', desired_gateway)
        run('docker', 'exec', gateway, 'nginx', '-t')
        run('docker', 'exec', gateway, 'nginx', '-s', 'reload')
        config = dict(old['Config'])
        config['Env'] = [k + '=' + v for k, v in {**existing, **changes}.items()]
        run('docker', 'stop', '-t', '30', platform)
        run('docker', 'rename', platform, rollback)
        switched = True
        created = create(platform, config, old['HostConfig'])
        run('docker', 'start', platform)
        for attempt in range(45):
            try:
                req = urllib.request.Request('http://127.0.0.1:5300/healthz', headers={'Host': '61.136.101.179:20281'})
                urllib.request.urlopen(req, timeout=3).close()
                break
            except Exception:
                if attempt == 44:
                    raise
                time.sleep(1)
        release_file('compose.yaml', desired_compose)
        print('PERSONAL ROUTING ENABLED: ' + stamp, flush=True)
        print('Original research owner retained; new users use private Docker volumes', flush=True)
        print('Rollback metadata: ' + str(root), flush=True)
    except BaseException:
        # Restore owner-only admission before restoring the shared-data proxy.
        if created:
            run('docker', 'rm', '-f', created)
        if switched:
            run('docker', 'rename', rollback, platform)
            run('docker', 'start', platform)
        release_file('nginx.conf', nginx)
        release_file('compose.yaml', compose)
        run('docker', 'exec', gateway, 'nginx', '-s', 'reload')
        if provisioner_created:
            run('docker','stop',provisioner)
            run('docker','rename',provisioner,provisioner+'-failed-'+stamp.lower())
        if previous_provisioner:
            run('docker','rename',previous_provisioner[0],provisioner)
            if previous_provisioner[1]:run('docker','start',provisioner)
        raise
    finally:
        environment.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--package', required=True, type=Path)
    parser.add_argument('--capacity', type=int, default=6)
    args = parser.parse_args()
    if args.capacity < 1:
        parser.error('Capacity must be positive')
    os.umask(0o077)
    result = args.package / 'personal-exit-code'
    try:
        main(args.package.resolve(), args.capacity)
    except BaseException:
        result.write_text('1\n')
        raise
    else:
        result.write_text('0\n')
