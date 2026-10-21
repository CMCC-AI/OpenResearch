"""Migrate MobileSci to the official OpenCode configuration API and live settings.

Run after update-server.py with the same verified update package. Default is a
read-only plan; --apply checks idle admission, saves rollback metadata, and
replaces containers while retaining every HOME volume and credential.
"""
import argparse
import copy
import datetime
import fcntl
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

SHARED = '/opt/mobilesci/state/opencode'
TARGET = '/home/node/.config/opencode'
ADMIN = 'mobilesci-remote-opencode-admin-1'
URL = 'http://127.0.0.1:4970'


def run(*args, capture=False, **kwargs):
    result = subprocess.run(args, check=True, text=True, capture_output=capture, **kwargs)
    return result.stdout.strip() if capture else None


def inspect(name):
    return json.loads(run('docker', 'inspect', name, capture=True))[0]


def values(config):
    return dict(entry.split('=', 1) for entry in config.get('Env', []))


def admin_service(image):
    return {
        'image': image, 'network_mode': 'host',
        'command': ['sh', '-ec', 'mkdir -p "$$XDG_DATA_HOME/opencode"; cp /run/orx-auth/auth.json "$$XDG_DATA_HOME/opencode/auth.json"; exec opencode serve --pure --hostname 127.0.0.1 --port 4970'],
        'environment': {
            'HOME': '/tmp/opencode-admin', 'XDG_CONFIG_HOME': '/run/orx-config',
            'XDG_DATA_HOME': '/tmp/opencode-admin/data', 'XDG_STATE_HOME': '/tmp/opencode-admin/state',
            'XDG_CACHE_HOME': '/tmp/opencode-admin/cache', 'OPENCODE_CONFIG_PROJECT_DISABLE': '1',
            'OPENCODE_DISABLE_AUTOUPDATE': '1',
        },
        'volumes': [SHARED + ':/run/orx-config/opencode',
                    '/opt/mobilesci/state/opencode-auth/auth.json:/run/orx-auth/auth.json:ro'],
        'tmpfs': ['/tmp:uid=1000,gid=1000,mode=0700'], 'read_only': True,
        'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
        'restart': 'unless-stopped', 'init': True,
    }


def desired_compose(compose, workbench_image, executor_image):
    result = copy.deepcopy(compose)
    services = result['services']
    services['platform'].setdefault('environment', {})['OPENCODE_ADMIN_URL'] = URL
    dependencies = services['platform'].setdefault('depends_on', {})
    if isinstance(dependencies, list):
        dependencies = {name: {'condition': 'service_started'} for name in dependencies}
        services['platform']['depends_on'] = dependencies
    dependencies['opencode-admin'] = {'condition': 'service_started'}
    services['opencode-admin'] = admin_service(workbench_image)
    env = services['provisioner'].setdefault('environment', {})
    env['MANAGED_OPENCODE_LIVE_CONFIG_DIR'] = SHARED
    env.pop('MANAGED_OPENCODE_CONFIG_DIR', None)
    env['MANAGED_EXECUTOR_IMAGE'] = executor_image
    return result


def desired_executor(old, image):
    config = copy.deepcopy(old['Config'])
    host = copy.deepcopy(old['HostConfig'])
    config['Image'] = image
    config['Env'] = [entry for entry in config['Env'] if not entry.startswith('MANAGED_CONFIG_SEED_DIR=')]
    destinations = {TARGET, TARGET + '/opencode.json', '/run/orx-seed/opencode'}
    host['Binds'] = [bind for bind in host.get('Binds', []) if bind.split(':')[1] not in destinations]
    host['Binds'].append(SHARED + ':' + TARGET + ':ro')
    return config, host


class DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def create(name, config, host):
    connection = DockerHTTP('localhost', timeout=30)
    connection.request('POST', '/containers/create?name=' + name,
                       json.dumps({**config, 'HostConfig': host}), {'Content-Type': 'application/json'})
    response = connection.getresponse()
    body = response.read()
    connection.close()
    if response.status != 201:
        raise RuntimeError('Container creation failed (details withheld to protect credentials)')
    return json.loads(body)['Id']


def probe(url, host=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Host': host} if host else {}), timeout=5) as response:
        return json.load(response)


def wait(url, host=None):
    for attempt in range(90):
        try:
            return probe(url, host)
        except Exception:
            if attempt == 89:
                raise RuntimeError('Service readiness timeout: ' + url)
            time.sleep(1)


def assert_idle(names):
    for name in names:
        activity = json.loads(run('docker', 'exec', name, 'node', '-e',
            "fetch('http://127.0.0.1:4791/api/projects/activity').then(r=>{if(!r.ok)throw Error('Activity unavailable');return r.json()}).then(d=>console.log(JSON.stringify(d.activity)))", capture=True))
        if any(row.get('activeAgents') or row.get('runningExperiments') for row in activity):
            raise RuntimeError('Active research blocks migration: ' + name)
        counts = json.loads(run('docker', 'exec', name, 'python3', '-c',
            "import sqlite3,time,json;c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True);print(json.dumps([c.execute('select count(*) from chat_queued_messages').fetchone()[0],c.execute('select count(*) from chat_turn_leases where heartbeat_at > ?', (int(time.time()*1000)-60000,)).fetchone()[0],c.execute(\"select count(*) from chat_spawns where state != 'done'\").fetchone()[0]]))", capture=True))
        if any(counts):
            raise RuntimeError('Queued or dispatching research blocks migration: ' + name)


def main(package, apply=False):
    platform_name, provisioner_name, workbench_name = ['mobilesci-remote-' + s + '-1' for s in ['platform', 'provisioner', 'workbench']]
    platform, provisioner, workbench = [inspect(name) for name in [platform_name, provisioner_name, workbench_name]]
    for service, item in [('platform', platform), ('provisioner', provisioner), ('workbench', workbench)]:
        labels = item['Config'].get('Labels') or {}
        if labels.get('com.docker.compose.project') != 'mobilesci-remote' or labels.get('com.docker.compose.service') != service:
            raise RuntimeError('Unexpected service ownership: ' + service)
    names = run('docker', 'ps', '-aq', '--filter', 'label=openresearch.managed=true', capture=True).split()
    private = []
    for name in names:
        item = inspect(name)
        workspace = item['Config'].get('Labels', {}).get('openresearch.workspace')
        if item['Name'] != '/orx-managed-' + str(workspace):
            continue  # Retained rollback containers must never be restarted.
        if 'src/connector-entry.mjs' not in (item['Config'].get('Cmd') or []):
            private.append(item)
    print('Plan: enable internal official API; migrate %d private executor(s); retain all data volumes' % len(private), flush=True)
    if not apply:
        return
    lock = (Path.home() / '.mobilesci-update.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert_idle([workbench_name, *[item['Name'][1:] for item in private]])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path.home() / ('.mobilesci-opencode-upgrade-' + stamp)
    backup.mkdir(mode=0o700)
    originals = {item['Name'][1:]: item for item in [platform, provisioner, *private]}
    (backup / 'containers.json').write_text(json.dumps(originals))
    (backup / 'containers.json').chmod(0o600)
    image = platform['Config']['Image']

    def release(name, content=None):
        script = "const fs=require('fs');const p='/release/'+process.argv[1];" + (
            "fs.writeFileSync(p,fs.readFileSync(0),{mode:0o600});" if content is not None else
            "process.stdout.write(fs.readFileSync(p,'utf8'));"
        )
        args = ['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0',
                '--mount', 'type=bind,source=/opt/mobilesci/current,target=/release' + (',readonly' if content is None else ''),
                '--entrypoint', 'node', image, '-e', script, name]
        return run(*args, capture=True, input=content)

    original_compose = release('compose.yaml')
    (backup / 'compose.before.yaml').write_text(original_compose)
    with tempfile.TemporaryDirectory(prefix='opencode-compose-') as temporary:
        candidate = Path(temporary) / 'compose.yaml'
        candidate.write_text(original_compose)
        parsed = json.loads(run('docker', 'compose', '--env-file', '/dev/null', '--project-directory', '/opt/mobilesci/current', '-f', str(candidate), 'config', '--no-interpolate', '--format', 'json', capture=True))
    # A dedicated build keeps the installed OpenCode version and runtime dependencies.
    executor_image = 'mobilesci-unified-executor:' + stamp.lower()
    if private:
        context = backup / 'executor-build'
        context.mkdir()
        import shutil
        shutil.copy2(package / 'workbench/orx', context / 'orx')
        shutil.copytree(package / 'platform/src', context / 'src')
        base = 'mobilesci-opencode-executor-base:' + stamp.lower()
        run('docker', 'tag', private[0]['Image'], base)
        (context / 'Dockerfile').write_text('FROM ' + base + '\nCOPY --chmod=755 orx /usr/local/bin/orx\nCOPY src /app/platform/src\n')
        run('docker', 'build', '--pull=false', '-t', executor_image, str(context))
    else:
        executor_image = values(provisioner['Config'])['MANAGED_EXECUTOR_IMAGE']
    desired = desired_compose(parsed, workbench['Config']['Image'], executor_image)
    rendered = json.dumps(desired, indent=2) + '\n'
    # Preserve placeholders in persisted Compose; use validation-only env values.
    with tempfile.TemporaryDirectory(prefix='opencode-validate-') as temporary:
        candidate = Path(temporary) / 'compose.yaml'
        candidate.write_text(rendered)
        import re
        dummy = {name: 'validation-only' for name in re.findall(r'\$\{([A-Z_0-9]+)', rendered)}
        run('docker', 'compose', '--env-file', '/dev/null', '-f', str(candidate), 'config', '--quiet', env={**os.environ, **dummy})
    assert_idle([workbench_name, *[item['Name'][1:] for item in private]])
    # Back up shared settings and credentials without exposing them to stdout.
    archive_code = "const cp=require('child_process'),fs=require('fs');let b=cp.execFileSync('tar',['czf','-','-C','/state','opencode','opencode-auth']);fs.writeFileSync('/backup/settings.tgz',b,{mode:0o600})"
    run('docker', 'run', '--rm', '--network', 'none', '--user', '0', '--read-only', '--mount', 'type=bind,source=/opt/mobilesci/state,target=/state,readonly', '--mount', 'type=bind,source=' + str(backup) + ',target=/backup', '--entrypoint', 'node', image, '-e', archive_code)
    changed = []
    admin_created = False
    compose_changed = False
    provisioner_stopped = False
    try:
        run('docker', 'stop', '-t', '30', provisioner_name)
        provisioner_stopped = True
        existing_admin = run('docker', 'ps', '-aq', '--filter', 'name=^/' + ADMIN + '$', capture=True)
        if existing_admin:
            existing = inspect(ADMIN)
            labels = existing['Config'].get('Labels') or {}
            if labels.get('com.docker.compose.project') != 'mobilesci-remote' or labels.get('com.docker.compose.service') != 'opencode-admin':
                raise RuntimeError('Unexpected configuration service ownership')
            if not existing['State']['Running']:
                raise RuntimeError('Existing configuration service is stopped; inspect it before migration')
        service = admin_service(workbench['Config']['Image'])
        admin_config = {
            'Image': workbench['Image'], 'User': '1000:1000', 'Cmd': [part.replace('$$', '$') for part in service['command']],
            'Entrypoint': None, 'Env': [k + '=' + v for k, v in service['environment'].items()],
            'Labels': {'com.docker.compose.project': 'mobilesci-remote', 'com.docker.compose.service': 'opencode-admin'},
        }
        admin_host = {
            'NetworkMode': 'host', 'Binds': service['volumes'], 'ReadonlyRootfs': True,
            'Tmpfs': {'/tmp': 'uid=1000,gid=1000,mode=0700'}, 'CapDrop': ['ALL'],
            'SecurityOpt': ['no-new-privileges:true'], 'Init': True, 'RestartPolicy': {'Name': 'unless-stopped'},
        }
        if not existing_admin:
            create(ADMIN, admin_config, admin_host)
            admin_created = True
            run('docker', 'start', ADMIN)
        wait(URL + '/global/config')

        def replace(name, config, host):
            old = originals[name]
            rollback = name + '-before-opencode-' + stamp.lower()
            entry = {'name': name, 'old': old, 'new': None, 'rollback': rollback, 'renamed': False}
            changed.append(entry)
            if inspect(name)['State']['Running']:
                run('docker', 'stop', '-t', '120', name)
            run('docker', 'rename', name, rollback)
            entry['renamed'] = True
            entry['new'] = create(name, config, host)
            run('docker', 'start', name)

        config = copy.deepcopy(platform['Config'])
        config['Env'] = [k + '=' + v for k, v in {**values(config), 'OPENCODE_ADMIN_URL': URL}.items()]
        replace(platform_name, config, platform['HostConfig'])
        wait('http://127.0.0.1:5300/healthz', '61.136.101.179:20281')
        for item in private:
            name = item['Name'][1:]
            config, host = desired_executor(item, executor_image)
            replace(name, config, host)
            for attempt in range(90):
                state = inspect(name)['State']
                if state.get('Health', {}).get('Status') == 'healthy':
                    break
                if attempt == 89:
                    raise RuntimeError('Private executor readiness timeout')
                time.sleep(1)
        config = copy.deepcopy(provisioner['Config'])
        env = values(config)
        env.pop('MANAGED_OPENCODE_CONFIG_DIR', None)
        env.update(MANAGED_OPENCODE_LIVE_CONFIG_DIR=SHARED, MANAGED_EXECUTOR_IMAGE=executor_image)
        config['Env'] = [k + '=' + v for k, v in env.items()]
        # Use the current platform source so future spaces suppress obsolete seeds.
        config['Image'] = platform['Config']['Image']
        replace(provisioner_name, config, provisioner['HostConfig'])
        # All processes are healthy before making the new configuration persistent.
        release('compose.yaml', rendered)
        compose_changed = True
        summary_code = "const {opencodeSettings}=await import('./src/opencode-settings.mjs');let s=await opencodeSettings('',process.env.OPENCODE_ADMIN_URL).read();console.log(JSON.stringify({enabled:s.enabled,backend:s.backend,providers:s.providers.map(p=>({id:p.id,connected:p.connected,models:p.models.length}))}))"
        summary = json.loads(run('docker', 'exec', platform_name, 'node', '--input-type=module', '-e', summary_code, capture=True))
        if not summary.get('enabled') or summary.get('backend') != 'opencode':
            raise RuntimeError('Configuration API verification failed')
        (backup / 'result.json').write_text(json.dumps({'backup': str(backup), 'executorImage': executor_image, 'summary': summary}))
        print('OpenCode unified configuration enabled; rollback: ' + str(backup), flush=True)
        print(json.dumps(summary), flush=True)
    except BaseException:
        if compose_changed:
            release('compose.yaml', original_compose)
        # Keep the provisioner down until the original private executors are restored.
        subprocess.run(['docker', 'stop', '-t', '10', provisioner_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for entry in reversed(changed):
            if entry['new']:
                subprocess.run(['docker', 'rm', '-f', entry['new']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if entry['renamed']:
                run('docker', 'rename', entry['old']['Id'], entry['name'])
        for name, old in originals.items():
            if name != provisioner_name and old['State']['Running']:
                run('docker', 'start', name)
        if admin_created:
            run('docker', 'rm', '-f', ADMIN)
        if provisioner_stopped and provisioner['State']['Running']:
            run('docker', 'start', provisioner_name)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    main(args.package.resolve(), args.apply)
