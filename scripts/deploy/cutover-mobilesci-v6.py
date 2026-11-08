"""Fixed .6 cutover for the verified mobilesci-replica deployment.

Default is read-only planning. --apply requires the reviewed plan fingerprint.
No builds, credential changes, model calls, automatic updates or database restore.
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
import shutil
import shlex
import socket
import sqlite3
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

REVISION = 'ba641033954d7a5a92cc099ee63106b788d8f2ba'
VERSION = '0.2.23-mobilesci.6'
ROOT = Path('/opt/mobilesci/candidates/ba64103-20261107')
RELEASE = Path('/opt/mobilesci/releases/f817211')
CURRENT = Path('/opt/mobilesci/current')
BACKUPS = Path('/opt/mobilesci/backups')
PLATFORM = 'mobilesci-replica-platform-1'
PROVISIONER = 'mobilesci-replica-provisioner-1'
GATEWAY = 'mobilesci-replica-gateway-1'
DATABASE = 'mobilesci-replica-platform-db-1'
PRIVATE = ['orx-managed-0530872b-9889-46c5-b2bd-cc228ab0cf28',
           'orx-managed-76ab2832-1a72-4a2d-bcfc-12f65565a14b']
EXECUTOR_IMAGE = 'sha256:551947d0754b1c73bc62c47e6d3d3297c360a7a054d57dfee1bb8c3b1bd67a81'
PLATFORM_IMAGE = 'sha256:c9884f1e3c1fea0d3b3d23dbc18c998822232f940341cd6b7d04d3fc239a8883'
OLD_EXECUTOR = 'sha256:276940ee6cba781a5a40b268dfd409075bbf889141438d426b0ebe99bf826b45'
OLD_PLATFORM = 'sha256:5a36fa118608d9bb403aee850a58f18d723d3f3d0a98fdc19aaaec23ecc1ecbb'
DATABASE_IMAGE = 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
ACCEPTANCE = {
    ROOT / 'accept-materials-result.json': 'a7d0509de374150c757909a7b9eb412d5962f5841de72c1f9539a90d7c71e77b',
    Path('/opt/mobilesci/backups/acceptance-ba64103-20261107/result.json'): 'd692b71fec095ba81e1dbf57b3c53b7d80212e210e7640197e0129a47e9cca2b',
    Path('/opt/mobilesci/backups/acceptance-ba64103-20261107/platform/result.json'): '2e3c053cbcf653a33631bf5ce040b831f5eb9957a567aedf81f3c4b4337c8f56',
}
IDLE_QUERIES = [
    'SELECT count(*) FROM chat_queued_messages',
    'SELECT count(*) FROM chat_turn_leases WHERE heartbeat_at>?',
    "SELECT count(*) FROM chat_spawns WHERE state!='done'",
    "SELECT count(*) FROM runs WHERE status NOT IN ('done','failed','cancelled')",
]


def run(*args, capture=False):
    result = subprocess.run(args, capture_output=capture, text=True)
    if result.returncode:
        raise RuntimeError('Command failed; inspect private execution log')
    return result.stdout.strip() if capture else None


def inspect(name):
    return json.loads(run('docker', 'inspect', name, capture=True))[0]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            sha.update(block)
    return sha.hexdigest()


def environment(config):
    return dict(value.split('=', 1) for value in config.get('Env', []))


def managed_environment(env):
    result = dict(env)
    for key in ('MANAGED_EXECUTOR_IMAGE', 'MANAGED_CONNECTOR_IMAGE'):
        if result.get(key) != 'mobilesci-executor:3ad51016':
            raise RuntimeError('Unexpected managed image reference: ' + key)
        result[key] = EXECUTOR_IMAGE
    return result


def validate_runtime_rows(rows):
    if {row['workspace_id'] for row in rows} != {name.removeprefix('orx-managed-') for name in PRIVATE}:
        raise RuntimeError('Persisted private runtime set changed')
    if any(row['desired'] != 'running' or row['status'] != 'ready' for row in rows):
        raise RuntimeError('A private space is queued, starting, failed or deleting')


def runtime_rows():
    query = "SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT workspace_id,status,desired FROM workspace_runtimes WHERE status<>'deleted' ORDER BY workspace_id) t"
    command = 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc ' + shlex.quote(query)
    return json.loads(run('docker', 'exec', '--env', 'PGOPTIONS=-c default_transaction_read_only=on',
                          DATABASE, 'sh', '-c', command, capture=True))


def desired_config(name, old):
    result = copy.deepcopy(old['Config'])
    if name == PLATFORM:
        result['Image'] = PLATFORM_IMAGE
    elif name in PRIVATE:
        result['Image'] = EXECUTOR_IMAGE
    elif name == PROVISIONER:
        result['Image'] = old['Image']
        result['Env'] = [key + '=' + value for key, value in
                         managed_environment(environment(result)).items()]
    else:
        raise RuntimeError('Unexpected replacement target')
    if 'com.docker.compose.image' in (result.get('Labels') or {}):
        result['Labels']['com.docker.compose.image'] = result['Image']
    return result


def desired_compose(original, provisioner_image):
    result = copy.deepcopy(original)
    if result['services']['platform']['image'] != 'mobilesci-platform:model-access-20261102':
        raise RuntimeError('Unexpected persisted platform image')
    provisioner = result['services']['provisioner']
    provisioner['environment'] = managed_environment(provisioner['environment'])
    provisioner['image'] = provisioner_image
    result['services']['platform']['image'] = PLATFORM_IMAGE
    return result


def tree_hashes(directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise RuntimeError('Unexpected static file type')
        if path.is_file():
            result[str(path.relative_to(directory))] = digest(path.read_bytes())
    if 'index.html' not in result:
        raise RuntimeError('Static index missing')
    return result


def verify_frozen_ui():
    archive = ROOT / ('MobileSci-' + VERSION + '.tar.gz')
    if digest(archive.read_bytes()) != '266618ed8bb4ba5bb0f56c2dc597e444c6f336f01148d338fcacf06e2bb7e109':
        raise RuntimeError('Frozen archive changed')
    expected = {}
    prefix = 'MobileSci-' + VERSION + '/ui/dist/'
    with tarfile.open(archive) as source:
        for item in source:
            if item.name.startswith(prefix) and item.isfile():
                expected[item.name[len(prefix):]] = digest(source.extractfile(item).read())
    if tree_hashes(ROOT / 'source/ui/dist') != expected:
        raise RuntimeError('Frozen static files changed')
    return expected


def read_compose(path):
    return json.loads(run('docker', 'compose', '--env-file', '/dev/null',
        '--project-directory', str(RELEASE), '-f', str(path), 'config',
        '--no-interpolate', '--format', 'json', capture=True))


def review_snapshot(detail):
    result = {key: detail[key] for key in ['Id', 'Image', 'Config', 'HostConfig', 'Mounts']}
    # Docker inspect enumerates a mount map; list order carries no semantics.
    # Retain every field and duplicate, without changing the create payload.
    result['Mounts'] = sorted(detail['Mounts'], key=lambda mount: json.dumps(mount, sort_keys=True))
    return result


def plan():
    if CURRENT.resolve() != RELEASE or any((CURRENT / name).is_symlink()
            for name in ['ui', 'compose.yaml', 'nginx.conf', '.env']):
        raise RuntimeError('Release paths changed')
    originals = {name: inspect(name) for name in [PLATFORM, PROVISIONER, GATEWAY, *PRIVATE]}
    discovered = set(run('docker', 'ps', '--filter', 'label=openresearch.managed=true',
                         '--format', '{{.Names}}', capture=True).splitlines())
    if discovered != set(PRIVATE):
        raise RuntimeError('Private runtime set changed; review all targets')
    for name, old in originals.items():
        if not old['State']['Running']:
            raise RuntimeError('Target is not running: ' + name)
        labels = old['Config'].get('Labels') or {}
        if name in PRIVATE:
            if (old['Image'] != OLD_EXECUTOR or old['HostConfig']['NetworkMode'] != 'bridge'
                    or set(old['NetworkSettings']['Networks']) != {'bridge'}
                    or labels.get('openresearch.workspace') != name.removeprefix('orx-managed-')
                    or labels.get('openresearch.managed') != 'true'):
                raise RuntimeError('Private runtime identity changed')
        elif labels.get('com.docker.compose.project') != 'mobilesci-replica':
            raise RuntimeError('Unexpected Compose project')
    if originals[PLATFORM]['Image'] != OLD_PLATFORM:
        raise RuntimeError('Platform base changed')
    database = inspect(DATABASE)
    if database['Image'] != DATABASE_IMAGE or not database['State']['Running']:
        raise RuntimeError('Database identity changed')
    rows = runtime_rows()
    validate_runtime_rows(rows)
    origin = environment(originals[PLATFORM]['Config']).get('OPENRESEARCH_APP_ORIGIN')
    if origin != 'http://49.232.238.110:20281':
        raise RuntimeError('Public origin changed; review entry checks')
    mounts = {(m['Source'], m['Destination'], m['RW']) for m in originals[GATEWAY]['Mounts']}
    if (str(CURRENT / 'ui'), '/usr/share/nginx/html', False) not in mounts:
        raise RuntimeError('Unexpected gateway static mount')
    if (str(CURRENT / 'nginx.conf'), '/etc/nginx/conf.d/default.conf', False) not in mounts:
        raise RuntimeError('Unexpected gateway configuration mount')
    for image in (EXECUTOR_IMAGE, PLATFORM_IMAGE):
        d = json.loads(run('docker', 'image', 'inspect', image, capture=True))[0]
        if d['Id'] != image or d['Config'].get('Labels', {}).get('org.opencontainers.image.revision') != REVISION:
            raise RuntimeError('Candidate image identity changed')
    for path, expected in ACCEPTANCE.items():
        if not path.is_file() or digest(path.read_bytes()) != expected:
            raise RuntimeError('Missing or changed isolated acceptance result')
    ui = verify_frozen_ui()
    compose = read_compose(CURRENT / 'compose.yaml')
    updated = desired_compose(compose, originals[PROVISIONER]['Image'])
    configs = {name: desired_config(name, old) for name, old in originals.items() if name != GATEWAY}
    current_ui = tree_hashes(CURRENT / 'ui')
    if any(path.startswith('assets/') and path in current_ui and current_ui[path] != sha
           for path, sha in ui.items()):
        raise RuntimeError('Conflicting cached asset; review before cutover')
    stable = {'containers': {name: review_snapshot(value) for name, value in originals.items()},
              'composeSha256': digest((CURRENT / 'compose.yaml').read_bytes()),
              'nginxSha256': digest((CURRENT / 'nginx.conf').read_bytes()),
              'environmentSha256': digest((CURRENT / '.env').read_bytes()) if (CURRENT / '.env').exists() else None,
              'currentUi': current_ui, 'candidateUi': ui,
              'databaseId': database['Id'], 'databaseImage': database['Image'], 'runtimeRows': rows}
    fingerprint = digest(json.dumps(stable, sort_keys=True).encode())
    return {'fingerprint': fingerprint, 'originals': originals, 'compose': updated,
            'configs': configs, 'origin': origin, 'ui': ui}


def assert_idle(names):
    validate_runtime_rows(runtime_rows())
    for name in names:
        code = "fetch('http://127.0.0.1:4791/api/projects/activity').then(r=>{if(!r.ok)throw Error('activity');return r.json()}).then(d=>{if(!Array.isArray(d.activity))throw Error('shape');console.log(JSON.stringify(d.activity))})"
        activity = json.loads(run('docker', 'exec', name, 'node', '-e', code, capture=True))
        if any(not isinstance(row.get(key), int) or row[key] < 0
               for row in activity for key in ['activeAgents', 'runningExperiments']):
            raise RuntimeError('Unknown activity response: ' + name)
        if any(row.get('activeAgents') or row.get('runningExperiments') for row in activity):
            raise RuntimeError('Active research blocks cutover: ' + name)
        code = "import sqlite3,time,json;c=sqlite3.connect('file:/home/node/research/state/orx.db?mode=ro',uri=True);c.execute('PRAGMA query_only=ON');queries=" + repr(IDLE_QUERIES) + ";print(json.dumps([c.execute(q, (int(time.time()*1000)-60000,) if '?' in q else ()).fetchone()[0] for q in queries]))"
        counts = json.loads(run('docker', 'exec', name, 'python3', '-c', code, capture=True))
        if len(counts) != 4 or any(counts):
            raise RuntimeError('Queued, leased, spawned or unfinished work blocks cutover: ' + name)


def atomic_write(path, data):
    old = path.stat()
    tmp = path.with_name(path.name + '.cutover-tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, old.st_mode & 0o777)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), old.st_mode & 0o777)
            os.fchown(stream.fileno(), old.st_uid, old.st_gid)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


class DockerHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')


def create(name, config, host):
    conn = DockerHTTP('localhost', timeout=30)
    conn.request('POST', '/containers/create?name=' + name,
                 json.dumps({**config, 'HostConfig': host}), {'Content-Type': 'application/json'})
    response = conn.getresponse()
    body = response.read()
    conn.close()
    if response.status != 201:
        raise RuntimeError('Candidate container creation failed; details withheld')
    return json.loads(body)['Id']


def lookup(name):
    conn = DockerHTTP('localhost', timeout=30)
    conn.request('GET', '/containers/' + urllib.parse.quote(name, safe='') + '/json')
    response = conn.getresponse()
    body = response.read()
    conn.close()
    if response.status == 404:
        return None
    if response.status != 200:
        raise RuntimeError('Container lookup failed')
    return json.loads(body)


def wait_ready(name):
    for _ in range(90):
        old = inspect(name)
        if not old['State']['Running']:
            raise RuntimeError('Container exited: ' + name)
        if name == PLATFORM:
            try:
                fetch('http://127.0.0.1:5300/healthz')
                return
            except (OSError, urllib.error.URLError):
                pass
        elif old['State'].get('Health', {}).get('Status') == 'healthy':
            code = "fetch('http://127.0.0.1:4791/api/health').then(r=>r.json()).then(d=>{if(!d.ok||d.version!==" + json.dumps(VERSION) + ")process.exit(1)})"
            run('docker', 'exec', name, 'node', '-e', code, capture=True)
            return
        time.sleep(1)
    raise RuntimeError('Readiness timeout: ' + name)


def fetch(url):
    request = urllib.request.Request(url, headers={'Host': '49.232.238.110:20281'})
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.read()


def public_checks(expected):
    for path, sha in expected.items():
        route = '' if path == 'index.html' else urllib.parse.quote(path)
        if digest(fetch('http://127.0.0.1:20281/mobilesci/' + route)) != sha:
            raise RuntimeError('Public static content mismatch: ' + path)
    try:
        fetch('http://127.0.0.1:20281/mobilesci/api/projects')
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return
        raise RuntimeError('Unexpected anonymous API status') from None
    raise RuntimeError('Anonymous research access unexpectedly allowed')


def stage_ui(original, frozen, target):
    tree_hashes(original)
    candidate = tree_hashes(frozen)
    shutil.copytree(original, target)
    for relative in candidate:
        path = target / relative
        # Hash-named assets must not silently change under a cached old page.
        if relative.startswith('assets/') and path.exists() and digest(path.read_bytes()) != candidate[relative]:
            raise RuntimeError('Conflicting cached asset: ' + relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        for parent in [path.parent, *path.parent.parents]:
            if parent == target.parent:
                break
            parent.chmod(0o755)
        shutil.copy2(frozen / relative, path)
        path.chmod(0o644)
    return tree_hashes(target)


def backup_databases(state, backup):
    for name in PRIVATE:
        old = state['originals'][name]
        if environment(old['Config']).get('ORX_DATA_DIR') != '/home/node/research/state':
            raise RuntimeError('Unexpected data directory')
        home = Path(next(m['Source'] for m in old['Mounts'] if m['Destination'] == '/home/node'))
        source = home / 'research/state/orx.db'
        if not source.resolve().is_relative_to(home.resolve()):
            raise RuntimeError('Database path escapes private volume')
        with sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True) as live:
            live.execute('PRAGMA query_only=ON')
            with sqlite3.connect(backup / (name + '.db')) as saved:
                deadline = time.monotonic() + 30
                def progress(*_):
                    if time.monotonic() > deadline:
                        raise RuntimeError('Online backup timed out')
                live.backup(saved, pages=128, progress=progress)
                if saved.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('SQLite backup integrity failed')
                if saved.execute('PRAGMA foreign_key_check').fetchall():
                    raise RuntimeError('SQLite backup foreign keys failed')
    with (backup / 'platform.dump').open('xb') as output:
        result = subprocess.run(['docker', 'exec', DATABASE, 'sh', '-c',
            'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],
            stdout=output, stderr=subprocess.PIPE, timeout=120)
        if result.returncode:
            raise RuntimeError('PostgreSQL backup failed; details withheld')
    with (backup / 'platform.dump').open('rb') as source:
        result = subprocess.run(['docker', 'exec', '-i', DATABASE, 'pg_restore', '--list'],
            stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
        if result.returncode:
            raise RuntimeError('PostgreSQL backup archive invalid')


def save_journal(backup, journal):
    temporary = backup / 'journal.tmp'
    with temporary.open('w') as stream:
        json.dump(journal, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(backup / 'journal.json')


def rollback(backup, journal):
    originals = journal['originals']
    present = {name: lookup(name) for name in originals}
    for name, current in present.items():
        if current is not None and current['Id'] != originals[name]['Id']:
            if name == GATEWAY or current['Config'].get('Labels', {}).get('sh.mobilesci.cutover') != journal['stamp']:
                raise RuntimeError('Refuse to touch an unowned replacement: ' + name)
    # The public entry stays fenced until old configuration and containers agree.
    run('docker', 'stop', '-t', '30', GATEWAY)
    if present[PROVISIONER] is not None:
        run('docker', 'stop', '-t', '30', PROVISIONER)
    for name in [PROVISIONER, *reversed(PRIVATE), PLATFORM]:
        old = originals[name]
        detail = lookup(name)
        if detail is not None:
            if detail['Id'] != old['Id']:
                if detail['Config'].get('Labels', {}).get('sh.mobilesci.cutover') != journal['stamp']:
                    raise RuntimeError('Refuse to remove an unowned replacement: ' + name)
                run('docker', 'rm', '-f', detail['Id'])
        retained = inspect(old['Id'])
        if retained['Name'] != '/' + name:
            run('docker', 'rename', old['Id'], name)
    compose = CURRENT / 'compose.yaml'
    if digest(compose.read_bytes()) not in journal['composeDigests']:
        raise RuntimeError('Compose changed outside this operation')
    atomic_write(compose, (backup / 'compose.before.yaml').read_bytes())
    if (backup / 'ui.before').exists():
        if (CURRENT / 'ui').exists():
            if tree_hashes(CURRENT / 'ui') != journal['stagedUi']:
                raise RuntimeError('Static directory changed outside this operation')
            (CURRENT / 'ui').rename(backup / 'ui.failed')
        (backup / 'ui.before').rename(CURRENT / 'ui')
    for name in [PLATFORM, *PRIVATE, PROVISIONER, GATEWAY]:
        if originals[name]['State']['Running']:
            run('docker', 'start', originals[name]['Id'])
    journal['result'] = 'rolled-back'
    save_journal(backup, journal)


def apply(state, expected):
    if state['fingerprint'] != expected:
        raise RuntimeError('Reviewed plan changed; do not apply')
    if shutil.disk_usage(RELEASE).free < 10 * 1024**3:
        raise RuntimeError('Insufficient free space')
    assert_idle(PRIVATE)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ').lower()
    backup = BACKUPS / ('cutover-ba64103-' + stamp)
    backup.mkdir(mode=0o700)
    original = (CURRENT / 'compose.yaml').read_bytes()
    (backup / 'compose.before.yaml').write_bytes(original)
    rendered = (json.dumps(state['compose'], indent=2) + '\n').encode()
    candidate = backup / 'compose.candidate.yaml'
    candidate.write_bytes(rendered)
    # Parse using the unchanged release directory and its existing .env.
    result = subprocess.run(['docker', 'compose', '--project-directory', str(RELEASE),
        '-f', str(candidate), 'config', '--quiet'], capture_output=True)
    if result.returncode:
        raise RuntimeError('Candidate Compose validation failed; details withheld')
    staged = stage_ui(CURRENT / 'ui', ROOT / 'source/ui/dist', backup / 'ui.staged')
    if backup.stat().st_dev != (CURRENT / 'ui').stat().st_dev:
        raise RuntimeError('Static exchange must stay on the same filesystem')
    journal = {'stamp': stamp, 'originals': state['originals'], 'plan': expected,
               'composeDigests': [digest(original), digest(rendered)], 'stagedUi': staged,
               'result': 'prepared', 'changes': []}
    save_journal(backup, journal)
    if plan()['fingerprint'] != expected:
        raise RuntimeError('Plan changed while staging; production was not stopped')
    try:
        run('docker', 'stop', '-t', '30', GATEWAY)
        run('docker', 'stop', '-t', '30', PROVISIONER)
        # Block new browser and provisioner traffic before the final live check.
        assert_idle(PRIVATE)
        run('docker', 'stop', '-t', '30', PLATFORM)
        assert_idle(PRIVATE)
        backup_databases(state, backup)
        journal['backups'] = {path.name: {'bytes': path.stat().st_size, 'sha256': file_digest(path)}
                              for path in backup.iterdir() if path.suffix in ('.db', '.dump')}
        save_journal(backup, journal)
        for name in [PLATFORM, *PRIVATE, PROVISIONER]:
            old = state['originals'][name]
            record = {'name': name, 'rollback': name + '-before-' + stamp, 'newId': None}
            journal['changes'].append(record)
            save_journal(backup, journal)
            if inspect(name)['State']['Running']:
                run('docker', 'stop', '-t', '120', name)
            run('docker', 'rename', old['Id'], record['rollback'])
            config = copy.deepcopy(state['configs'][name])
            config['Labels'] = dict(config.get('Labels') or {})
            config['Labels']['sh.mobilesci.cutover'] = stamp
            record['newId'] = create(name, config, old['HostConfig'])
            save_journal(backup, journal)
            # Leave provisioner stopped until persistence and static assets agree.
            if name != PROVISIONER:
                run('docker', 'start', record['newId'])
                wait_ready(name)
            new = inspect(record['newId'])
            if {(m['Source'], m['Destination'], m['RW']) for m in new['Mounts']} != {
                    (m['Source'], m['Destination'], m['RW']) for m in old['Mounts']}:
                raise RuntimeError('Container mounts changed: ' + name)
        atomic_write(CURRENT / 'compose.yaml', rendered)
        (CURRENT / 'ui').rename(backup / 'ui.before')
        (backup / 'ui.staged').rename(CURRENT / 'ui')
        run('docker', 'start', PROVISIONER)
        time.sleep(2)
        if not inspect(PROVISIONER)['State']['Running']:
            raise RuntimeError('Provisioner exited')
        run('docker', 'start', GATEWAY)
        public_checks(state['ui'])
        journal['result'] = 'healthy'
        save_journal(backup, journal)
    except BaseException:
        rollback(backup, journal)
        raise
    print(json.dumps({'status': 'healthy', 'revision': REVISION, 'backup': str(backup),
                      'plan': expected, 'modelsInvoked': False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-plan')
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    if not args.apply:
        if args.rollback:
            parser.error('--rollback also requires --apply')
        state = plan()
        print(json.dumps({'plan': state['fingerprint'], 'revision': REVISION,
                          'targets': list(state['originals']), 'apply': False,
                          'platformImage': PLATFORM_IMAGE, 'executorImage': EXECUTOR_IMAGE}))
        return
    if os.geteuid() != 0:
        parser.error('--apply requires root')
    os.umask(0o077)
    with (Path.home() / '.mobilesci-update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.rollback:
            backup = args.rollback.resolve()
            if backup.parent != BACKUPS or not backup.name.startswith('cutover-ba64103-'):
                parser.error('Unexpected rollback directory')
            journal = json.loads((backup / 'journal.json').read_text())
            if set(journal['originals']) != {PLATFORM, PROVISIONER, GATEWAY, *PRIVATE}:
                parser.error('Unexpected rollback target set')
            if inspect(GATEWAY)['State']['Running']:
                assert_idle(PRIVATE)
                run('docker', 'stop', '-t', '30', GATEWAY)
                try:
                    assert_idle(PRIVATE)
                except BaseException:
                    run('docker', 'start', GATEWAY)
                    raise
            rollback(backup, journal)
        else:
            if not args.expected_plan:
                parser.error('--apply requires --expected-plan')
            apply(plan(), args.expected_plan)


if __name__ == '__main__':
    main()
