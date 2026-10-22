"""Apply the material-upload tunnel fix to existing MobileSci images and runners.

Run with runner.mjs, runner-lock.mjs, tunnel.mjs and material-upload.test.mjs.
Defaults to read-only planning; --apply preserves volumes, credentials and bases.
"""
import argparse
import copy
import datetime
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.request

PLATFORM = 'mobilesci-remote-platform-1'
PROVISIONER = 'mobilesci-remote-provisioner-1'
WORKBENCH = 'mobilesci-remote-workbench-1'
RELEASE = '/opt/mobilesci/current'


def run(*args, capture=False, input=None):
    result = subprocess.run(args, check=True, text=True, capture_output=capture, input=input)
    return result.stdout.strip() if capture else None


def inspect(name):
    return json.loads(run('docker', 'inspect', name, capture=True))[0]


def owned_runtime(item, workspace_ids):
    labels = item['Config'].get('Labels') or {}
    workspace = labels.get('openresearch.workspace')
    return (workspace in workspace_ids and labels.get('openresearch.managed') == 'true'
            and item['Name'] == '/orx-managed-' + str(workspace))


def environment(config):
    return dict(entry.split('=', 1) for entry in config.get('Env', []))


def source_changes(env, images):
    result = dict(env)
    for key in ('MANAGED_EXECUTOR_IMAGE', 'MANAGED_CONNECTOR_IMAGE'):
        if key not in env or env[key] not in images:
            raise RuntimeError('Missing managed image mapping: ' + key)
        result[key] = images[env[key]]
    return result


def desired_compose(original, platform_image, provisioner_image, managed):
    result = copy.deepcopy(original)
    result['services']['platform']['image'] = platform_image
    result['services']['provisioner']['image'] = provisioner_image
    env = result['services']['provisioner'].setdefault('environment', {})
    if not isinstance(env, dict):
        raise RuntimeError('Expected mapping-style provisioner environment')
    for key in ('MANAGED_EXECUTOR_IMAGE', 'MANAGED_CONNECTOR_IMAGE'):
        env[key] = managed[key]
    return result


def assert_idle(names):
    for name in names:
        activity = json.loads(run('docker', 'exec', name, 'node', '-e',
            "fetch('http://127.0.0.1:4791/api/projects/activity').then(r=>{if(!r.ok)throw Error('Activity unavailable');return r.json()}).then(d=>console.log(JSON.stringify(d.activity)))", capture=True))
        if any(row.get('activeAgents') or row.get('runningExperiments') for row in activity):
            raise RuntimeError('Active research blocks upload patch: ' + name)
        counts = json.loads(run('docker', 'exec', name, 'python3', '-c',
            "import sqlite3,time,json;c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True);print(json.dumps([c.execute('select count(*) from chat_queued_messages').fetchone()[0],c.execute('select count(*) from chat_turn_leases where heartbeat_at > ?', (int(time.time()*1000)-60000,)).fetchone()[0],c.execute(\"select count(*) from chat_spawns where state != 'done'\").fetchone()[0]]))", capture=True))
        if any(counts):
            raise RuntimeError('Queued research blocks upload patch: ' + name)


def release(image, content=None):
    code = "const fs=require('fs'),p='/release/compose.yaml';" + (
        "const s=fs.statSync(p);fs.writeFileSync(p+'.upload-tmp',fs.readFileSync(0),{mode:s.mode&511});fs.chownSync(p+'.upload-tmp',s.uid,s.gid);fs.renameSync(p+'.upload-tmp',p);" if content is not None else
        "process.stdout.write(fs.readFileSync(p,'utf8'));"
    )
    return run('docker', 'run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0',
               '--mount', 'type=bind,source=' + RELEASE + ',target=/release' + (',readonly' if content is None else ''),
               '--entrypoint', 'node', image, '-e', code, capture=True, input=content)


class DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def create(name, config, host):
    conn = DockerHTTP('localhost', timeout=30)
    conn.request('POST', '/containers/create?name=' + name,
                 json.dumps({**config, 'HostConfig': host}), {'Content-Type': 'application/json'})
    response = conn.getresponse()
    data = response.read()
    conn.close()
    if response.status != 201:
        raise RuntimeError('Container creation failed (details withheld)')
    return json.loads(data)['Id']


def wait_healthy(name):
    for _ in range(90):
        detail = inspect(name)
        if not detail['State']['Running']:
            raise RuntimeError('Container exited: ' + name)
        if name == PLATFORM:
            try:
                req = urllib.request.Request('http://127.0.0.1:5300/healthz', headers={'Host': '61.136.101.179:20281'})
                with urllib.request.urlopen(req, timeout=5) as response:
                    if response.status == 200:
                        return
            except Exception:
                pass
        elif detail['State'].get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(1)
    raise RuntimeError('Readiness timeout: ' + name)


def main(source, apply=False):
    source = Path(source).resolve()
    for file in ('runner.mjs', 'runner-lock.mjs', 'tunnel.mjs', 'material-upload.test.mjs'):
        if not (source / file).is_file():
            raise RuntimeError('Missing patch source: ' + file)
    platform, provisioner = inspect(PLATFORM), inspect(PROVISIONER)
    for name, detail in ((PLATFORM, platform), (PROVISIONER, provisioner)):
        if detail['Config'].get('Labels', {}).get('com.docker.compose.project') != 'mobilesci-remote':
            raise RuntimeError('Unexpected deployment: ' + name)
    query = "const {createPool}=await import('./src/db.mjs');const p=createPool(process.env.DATABASE_URL);try{console.log(JSON.stringify((await p.query('SELECT id FROM workspaces')).rows.map(r=>r.id)))}finally{await p.end()}"
    workspace_ids = set(json.loads(run('docker', 'exec', PLATFORM, 'node', '--input-type=module', '-e', query, capture=True)))
    private = [item for name in run('docker', 'ps', '--filter', 'label=openresearch.managed=true', '--format', '{{.Names}}', capture=True).splitlines() if owned_runtime(item := inspect(name), workspace_ids)]
    if not private:
        raise RuntimeError('No managed runners discovered')
    idle_names = [WORKBENCH] + [item['Name'][1:] for item in private if 'src/connector-entry.mjs' not in (item['Config'].get('Cmd') or [])]
    assert_idle(idle_names)
    print(json.dumps({'targets': [PLATFORM, PROVISIONER] + [item['Name'][1:] for item in private], 'idle': True, 'apply': apply}), flush=True)
    if not apply:
        return
    lock = (Path.home() / '.mobilesci-update.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ').lower()
    backup = Path.home() / ('.mobilesci-upload-fix-' + stamp)
    backup.mkdir(mode=0o700)
    originals = {item['Name'][1:]: item for item in [platform, provisioner, *private]}
    os.umask(0o077)
    (backup / 'containers.json').write_text(json.dumps(originals))
    original_compose = release(platform['Image'])
    (backup / 'compose.before.yaml').write_text(original_compose)
    candidate = backup / 'compose.yaml'
    candidate.write_text(original_compose)
    parsed = json.loads(run('docker', 'compose', '--env-file', '/dev/null', '--project-directory', RELEASE,
                            '-f', str(candidate), 'config', '--no-interpolate', '--format', 'json', capture=True))
    refs = [platform['Image']] + [item['Image'] for item in private]
    managed_env = environment(provisioner['Config'])
    for key in ('MANAGED_EXECUTOR_IMAGE', 'MANAGED_CONNECTOR_IMAGE'):
        if not managed_env.get(key):
            raise RuntimeError('Missing ' + key)
        refs.append(managed_env[key])
    images = {}
    bases = {}
    for ref in refs:
        image_id = json.loads(run('docker', 'image', 'inspect', ref, capture=True))[0]['Id']
        if image_id not in bases:
            index = len(bases)
            base = f'mobilesci-upload-base:{stamp}-{index}'
            tag = f'mobilesci-upload-fix:{stamp}-{index}'
            run('docker', 'tag', image_id, base)
            context = backup / ('build-' + str(index))
            context.mkdir()
            for file in ('runner.mjs', 'runner-lock.mjs', 'tunnel.mjs'):
                (context / file).write_bytes((source / file).read_bytes())
            (context / 'Dockerfile').write_text('FROM ' + base + '\nCOPY --chmod=644 runner.mjs runner-lock.mjs tunnel.mjs /app/platform/src/\n')
            run('docker', 'build', '--pull=false', '-t', tag, str(context))
            code = "import {requestBodyLimit,MAX_RUNNER_FRAME} from './src/tunnel.mjs';if(requestBodyLimit('PUT','/api/projects/p/materials/m/files')!==33554432||requestBodyLimit('POST','/api/chat/sessions/s/message')!==8388608||MAX_RUNNER_FRAME<44739244)process.exit(1)"
            run('docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', tag, '--input-type=module', '-e', code)
            bases[image_id] = tag
        images[ref] = bases[image_id]
    new_env = source_changes(managed_env, images)
    run('docker', 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
        '--mount', 'type=bind,source=' + str(source / 'material-upload.test.mjs') + ',target=/app/platform/test/material-upload.test.mjs,readonly',
        '--entrypoint', 'node', images[platform['Image']], '--test', 'test/material-upload.test.mjs')
    rendered = json.dumps(desired_compose(parsed, images[platform['Image']], provisioner['Image'], new_env), indent=2) + '\n'
    candidate.write_text(rendered)
    dummy = {name: 'validation-only' for name in re.findall(r'\$\{([A-Z_0-9]+)', rendered)}
    subprocess.run(['docker', 'compose', '--env-file', '/dev/null', '--project-directory', RELEASE,
                    '-f', str(candidate), 'config', '--quiet'], env={**os.environ, **dummy}, check=True, capture_output=True)
    assert_idle(idle_names)
    changed = []
    stopped_provisioner = False
    persisted = False
    try:
        run('docker', 'stop', '-t', '30', PROVISIONER)
        stopped_provisioner = True
        assert_idle(idle_names)
        def replace(name, image, env=None, health=True):
            old = originals[name]
            record = {'name': name, 'rollback': name + '-upload-rollback-' + stamp, 'new': None, 'renamed': False}
            changed.append(record)
            (backup / 'changes.json').write_text(json.dumps(changed))
            if inspect(name)['State']['Running']:
                run('docker', 'stop', '-t', '120', name)
            run('docker', 'rename', name, record['rollback'])
            record['renamed'] = True
            (backup / 'changes.json').write_text(json.dumps(changed))
            config = copy.deepcopy(old['Config'])
            config['Image'] = image
            if env is not None:
                config['Env'] = [key + '=' + value for key, value in env.items()]
            record['new'] = create(name, config, old['HostConfig'])
            (backup / 'changes.json').write_text(json.dumps(changed))
            run('docker', 'start', name)
            if health:
                wait_healthy(name)
        replace(PLATFORM, images[platform['Image']])
        for item in private:
            replace(item['Name'][1:], images[item['Image']])
        # The provisioner's code stays on its original immutable image.
        replace(PROVISIONER, provisioner['Image'], env=new_env, health=False)
        if not inspect(PROVISIONER)['State']['Running']:
            raise RuntimeError('Provisioner exited')
        release(platform['Image'], rendered)
        persisted = True
        for name in [PLATFORM] + [item['Name'][1:] for item in private]:
            for file in ('runner.mjs', 'runner-lock.mjs', 'tunnel.mjs'):
                actual = subprocess.check_output(['docker', 'exec', name, 'cat', '/app/platform/src/' + file])
                if hashlib.sha256(actual).digest() != hashlib.sha256((source / file).read_bytes()).digest():
                    raise RuntimeError('Deployed code hash mismatch: ' + name)
            if name != PLATFORM:
                old_mounts = {(m['Destination'], m['Source'], m['RW']) for m in originals[name]['Mounts']}
                new_mounts = {(m['Destination'], m['Source'], m['RW']) for m in inspect(name)['Mounts']}
                if old_mounts != new_mounts:
                    raise RuntimeError('Mounts changed: ' + name)
        (backup / 'result.json').write_text(json.dumps({'images': images, 'targets': list(originals), 'status': 'healthy'}))
        print('Upload patch deployed; rollback: ' + str(backup), flush=True)
    except Exception:
        if persisted:
            release(platform['Image'], original_compose)
        subprocess.run(['docker', 'stop', '-t', '10', PROVISIONER], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for record in reversed(changed):
            if record['name'] == PROVISIONER:
                continue
            if record['new']:
                subprocess.run(['docker', 'rm', '-f', record['new']], check=True, stdout=subprocess.DEVNULL)
            if record['renamed']:
                run('docker', 'rename', record['rollback'], record['name'])
            if originals[record['name']]['State']['Running']:
                run('docker', 'start', record['name'])
        record = next((item for item in changed if item['name'] == PROVISIONER), None)
        if record:
            if record['new']:
                run('docker', 'rm', '-f', record['new'])
            if record['renamed']:
                run('docker', 'rename', record['rollback'], PROVISIONER)
        if stopped_provisioner:
            run('docker', 'start', PROVISIONER)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    main(args.source, args.apply)
