"""Deploy the private runtime pool patch to the existing MobileSci replica.

Default is a read-only plan. --apply retains executor images, HOME volumes,
credentials and accounts; backs up databases, configuration and static entry;
replaces only platform/provisioner and synchronizes their Compose definition.
"""
import argparse
import copy
import datetime
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.request

PLATFORM = 'mobilesci-replica-platform-1'
WORKER = 'mobilesci-replica-provisioner-1'
DATABASE = 'mobilesci-replica-platform-db-1'
CURRENT = Path('/opt/mobilesci/current')
IMAGE = 'mobilesci-runtime-pool:20261109'
BASE_HASHES = {
    'src/server.mjs': 'd28d966a7e6436295a8730917bdb9875312fc7273fabff6bbb69eba7d004e69f',
    'src/provisioner.mjs': '76897dc44fbc674977c697404f9063cda36cd56d5ac2cc63d3e3112ef258e16d',
    'src/personal-spaces.mjs': 'fa2b02de17625cc37e8d2a5ce046ea5c865658412c24687b24a340fff5d9098f',
}


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def inspect(name):
    return json.loads(run('docker', 'inspect', name))[0]


def lookup(name):
    try:
        return inspect(name)
    except subprocess.CalledProcessError:
        return None


class DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def create(name, config, host):
    connection = DockerHTTP('localhost', timeout=30)
    connection.request('POST', '/containers/create?name=' + name,
                       json.dumps({**config, 'HostConfig': host}),
                       {'Content-Type': 'application/json'})
    response = connection.getresponse()
    response.read()
    connection.close()
    if response.status != 201:
        raise RuntimeError('Container creation failed; private configuration withheld')


def environment(config):
    return dict(entry.split('=', 1) for entry in config['Env'])


def desired_compose(compose, image, capacity):
    result = copy.deepcopy(compose)
    for service in ['platform', 'provisioner']:
        result['services'][service]['image'] = image
    result['services']['provisioner']['environment'].update(
        MANAGED_CAPACITY=str(capacity), MANAGED_IDLE_SECONDS='120')
    return result


def desired_config(old, image, stamp, capacity, worker=False):
    config, host = copy.deepcopy(old['Config']), copy.deepcopy(old['HostConfig'])
    config['Image'] = image
    config.setdefault('Labels', {})['sh.mobilesci.runtime-pool'] = stamp
    if worker:
        env = environment(config)
        env.update(MANAGED_CAPACITY=str(capacity), MANAGED_IDLE_SECONDS='120')
        config['Env'] = [f'{key}={value}' for key, value in env.items()]
    return config, host


def atomic(path, data, mode=0o600):
    temporary = path.with_name(path.name + '.runtime-pool-tmp')
    with temporary.open('xb') as output:
        os.chmod(temporary, mode)
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)


def health():
    request = urllib.request.Request('http://127.0.0.1:5300/healthz',
                                    headers={'Host': '49.232.238.110:20281'})
    with urllib.request.urlopen(request, timeout=3) as response:
        if json.load(response).get('ok') is not True:
            raise RuntimeError('Platform health failed')


def wait_health():
    for _ in range(30):
        try:
            health()
            return
        except (OSError, ValueError):
            time.sleep(1)
    raise RuntimeError('Platform readiness timeout')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    stage = args.stage.resolve()
    manifest = json.loads((stage / 'manifest.json').read_bytes())
    for relative, expected in manifest.items():
        if not (stage / relative).resolve().is_relative_to(stage):
            raise RuntimeError('Invalid staged path')
        if hashlib.sha256((stage / relative).read_bytes()).hexdigest() != expected:
            raise RuntimeError('Staged source changed: ' + relative)
    if '"dataPreserved":true' not in (stage / 'real-smoke.log').read_text():
        raise RuntimeError('Real executor acceptance must pass first')
    old = {name: inspect(name) for name in [PLATFORM, WORKER]}
    for name, value in old.items():
        if (not value['State']['Running'] or value['HostConfig']['NetworkMode'] != 'host'
                or value['Config']['Labels'].get('com.docker.compose.project') != 'mobilesci-replica'):
            raise RuntimeError('Unexpected deployment target: ' + name)
    for path, expected in BASE_HASHES.items():
        actual = run('docker', 'exec', PLATFORM, 'sha256sum', path).decode().split()[0]
        if actual != expected:
            raise RuntimeError('Production source base changed: ' + path)
    image = inspect(IMAGE)['Id']
    env = environment(old[PLATFORM]['Config'])
    if env.get('OPENRESEARCH_APP_ORIGIN') != 'http://49.232.238.110:20281':
        raise RuntimeError('Unexpected app origin')
    capacity = int(env['MANAGED_CAPACITY'])
    compose = json.loads((CURRENT / 'compose.yaml').read_bytes())
    updated = desired_compose(compose, image, capacity)
    # Resolve before stopping services, rejecting invalid persisted configuration.
    plan = stage / 'compose.runtime-pool.json'
    plan.write_text(json.dumps(updated, indent=2) + '\n')
    os.chmod(plan, 0o600)
    run('docker', 'compose', '--env-file', '/dev/null', '--project-directory', str(CURRENT),
        '-f', str(plan), 'config', '--quiet')
    for source in (stage / 'ui/dist/assets').rglob('*'):
        target = CURRENT / 'ui/assets' / source.relative_to(stage / 'ui/dist/assets')
        if source.is_file() and target.exists() and source.read_bytes() != target.read_bytes():
            raise RuntimeError('Cached asset conflict: ' + source.name)
    print(json.dumps({'image': image, 'runningCapacity': capacity,
                      'accountLimit': None, 'idleSeconds': 120,
                      'targets': list(old), 'apply': args.apply}), flush=True)
    if not args.apply:
        return
    os.umask(0o077)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/opt/mobilesci/backups') / ('runtime-pool-' + stamp)
    backup.mkdir(mode=0o700)
    (backup / 'originals.json').write_text(json.dumps(old))
    shutil.copy2(CURRENT / 'compose.yaml', backup / 'compose.yaml')
    shutil.copy2(CURRENT / 'ui/index.html', backup / 'index.html')
    # No executor is replaced, but preserve a consistent recovery copy of each DB.
    names = run('docker', 'ps', '-a', '--filter', 'label=openresearch.managed=true',
                '--format', '{{.Names}}').decode().splitlines()
    for name in names:
        detail = inspect(name)
        home = next(Path(m['Source']) for m in detail['Mounts'] if m['Destination'] == '/home/node')
        source = home / 'research/state/orx.db'
        if source.exists():
            with sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True) as live:
                with sqlite3.connect(backup / (name + '.db')) as saved:
                    live.backup(saved)
                    if saved.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('SQLite backup invalid')
    dump = run('docker', 'exec', DATABASE, 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc')
    (backup / 'platform.dump').write_bytes(dump)
    run('docker', 'exec', '-i', DATABASE, 'pg_restore', '--list', input=dump)
    renamed, replacements = [], []
    migrated = False
    migration = 'mobilesci-pool-migrate-' + stamp.lower()
    try:
        # Stop the old provisioner before migration; existing researchers keep running.
        run('docker', 'stop', WORKER)
        config = {'Image': image, 'Env': old[PLATFORM]['Config']['Env'],
                  'Cmd': ['node', 'src/admin.mjs', 'migrate'], 'User': '1000:1000',
                  'WorkingDir': '/app/platform'}
        create(migration, config, {'NetworkMode': 'host', 'ReadonlyRootfs': True})
        run('docker', 'start', migration)
        status = run('docker', 'wait', migration).decode().strip()
        run('docker', 'rm', migration)
        if status != '0':
            raise RuntimeError('Database migration failed')
        migrated = True
        for name in [WORKER, PLATFORM]:
            run('docker', 'stop', name)
            previous = name + '-before-pool-' + stamp.lower()
            run('docker', 'rename', name, previous)
            renamed.append((name, previous))
            config, host = desired_config(old[name], image, stamp, capacity, name == WORKER)
            replacements.append(name)
            create(name, config, host)
        run('docker', 'start', PLATFORM)
        wait_health()
        atomic(CURRENT / 'compose.yaml', plan.read_bytes())
        for source in (stage / 'ui/dist').rglob('*'):
            if source.is_file() and source.name != 'index.html':
                target = CURRENT / 'ui' / source.relative_to(stage / 'ui/dist')
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists() or target.read_bytes() != source.read_bytes():
                    atomic(target, source.read_bytes(), 0o644)
        atomic(CURRENT / 'ui/index.html', (stage / 'ui/dist/index.html').read_bytes(), 0o644)
        run('docker', 'start', WORKER)
        time.sleep(3)
        health()
        if not inspect(WORKER)['State']['Running']:
            raise RuntimeError('Provisioner failed to start')
        for name in [PLATFORM, WORKER]:
            current = inspect(name)
            if current['Image'] != image or current['HostConfig'] != old[name]['HostConfig']:
                raise RuntimeError('Replacement resource or isolation configuration changed')
        result = {'healthy': True, 'image': image, 'backup': str(backup),
                  'executorsReplaced': False, 'runningCapacity': capacity,
                  'sourceManifestSha256': hashlib.sha256((stage / 'manifest.json').read_bytes()).hexdigest()}
        (backup / 'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    except Exception:
        for name in reversed(replacements):
            current = lookup(name)
            if current is None:
                continue
            if current['Config']['Labels'].get('sh.mobilesci.runtime-pool') != stamp:
                raise RuntimeError('Rollback target identity changed')
            run('docker', 'rm', '-f', name)
        if migrated:
            # Keep new state and data; old workers must not start an unbounded queue.
            sql = "UPDATE workspace_runtimes SET status='failed',error='研究环境维护中，请稍后重试' WHERE status IN ('waiting','sleeping');"
            run('docker', 'exec', '-i', DATABASE, 'sh', '-c',
                'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"', input=sql.encode())
        for name, previous in reversed(renamed):
            run('docker', 'rename', previous, name)
            run('docker', 'start', name)
        run('docker', 'start', WORKER)
        atomic(CURRENT / 'compose.yaml', (backup / 'compose.yaml').read_bytes())
        atomic(CURRENT / 'ui/index.html', (backup / 'index.html').read_bytes(), 0o644)
        wait_health()
        print('Deployment failed; original services and static entry restored. Backup: ' + str(backup), flush=True)
        raise


if __name__ == '__main__':
    main()
