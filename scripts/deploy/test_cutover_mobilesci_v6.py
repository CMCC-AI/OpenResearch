import copy
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import itertools
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('cutover-mobilesci-v6.py'))
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


@contextmanager
def gateway_server(status=200, delayed=False):
    activate = threading.Event()
    serving = threading.Event()
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(status)
            self.end_headers()
            self.wfile.write(b'gateway index')

        def log_message(self, *_):
            pass
    server = HTTPServer(('127.0.0.1', 0), Handler, bind_and_activate=False)
    server.server_bind()
    if not delayed:
        activate.set()
    def worker():
        activate.wait()
        server.server_activate()
        serving.set()
        server.serve_forever(poll_interval=0.01)
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    try:
        if not delayed:
            assert serving.wait(2)
        yield server.server_address[1], activate, requests
    finally:
        activate.set()
        if serving.wait(2):
            server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class Engine:
    def __init__(self, fail=None, lose_reply=False):
        self.fail = fail
        self.lose_reply = lose_reply
        self.calls = []
        self.items = {}
        for index, name in enumerate([cutover.PLATFORM, *cutover.PRIVATE, cutover.PROVISIONER, cutover.GATEWAY]):
            env = ['SECRET=preserve-this', 'OPENRESEARCH_APP_ORIGIN=http://49.232.238.110:20281']
            if name == cutover.PROVISIONER:
                env += ['MANAGED_EXECUTOR_IMAGE=mobilesci-executor:3ad51016',
                        'MANAGED_CONNECTOR_IMAGE=mobilesci-executor:3ad51016']
            self.items['old-' + str(index)] = {
                'Id': 'old-' + str(index), 'Name': '/' + name, 'Image': 'immutable-old-' + str(index),
                'Config': {'Image': 'tag-old-' + str(index), 'Env': env,
                           'Labels': {'keep': 'label'}, 'Cmd': ['unchanged'], 'User': '1000'},
                'HostConfig': {'Binds': ['private:/home/node'], 'NetworkMode': 'bridge',
                               'PortBindings': {'4791/tcp': [{'HostPort': '3491'}]}},
                'Mounts': [{'Source': 'private-' + str(index), 'Destination': '/home/node', 'RW': True}],
                'State': {'Running': True}}
        self.originals = {x['Name'][1:]: copy.deepcopy(x) for x in self.items.values()}

    def lookup(self, value):
        return next((x for x in self.items.values() if x['Name'] == '/' + value), None)

    def inspect(self, value):
        return copy.deepcopy(self.items.get(value) or self.lookup(value))

    def run(self, *args, **kwargs):
        self.calls.append(args)
        if args[0] != 'docker':
            raise AssertionError('Unexpected external command')
        command, target = args[1], args[-1]
        if command in ('stop', 'start'):
            item = self.items.get(target) or self.lookup(target)
            if item is None:
                raise RuntimeError('No such container')
            item['State']['Running'] = command == 'start'
        elif command == 'rename':
            item = self.items.get(args[2]) or self.lookup(args[2])
            self.assert_free(target)
            item['Name'] = '/' + target
        elif command == 'rm':
            del self.items[target]
        else:
            raise AssertionError('Unexpected Docker operation: ' + command)

    def assert_free(self, name):
        assert self.lookup(name) is None

    def create(self, name, config, host):
        self.assert_free(name)
        if self.fail == name and not self.lose_reply:
            raise RuntimeError('Injected failure before creation')
        item = copy.deepcopy(self.originals[name])
        item.update(Id='new-' + name, Name='/' + name, Image=config['Image'],
                    Config=copy.deepcopy(config), HostConfig=copy.deepcopy(host), State={'Running': False})
        self.items[item['Id']] = item
        if self.fail == name:
            raise RuntimeError('Injected lost create response')
        return item['Id']


class CutoverTests(unittest.TestCase):
    def test_review_fingerprint_ignores_only_mount_enumeration_order(self):
        engine = Engine()
        detail = copy.deepcopy(engine.originals[cutover.PRIVATE[0]])
        detail['Mounts'] = [
            {'Source': '/private/home', 'Destination': '/home/node', 'RW': True, 'Mode': 'z'},
            {'Source': '/private/model', 'Destination': '/run/model', 'RW': False, 'Mode': 'ro'},
            {'Source': '/private/token', 'Destination': '/run/token', 'RW': False, 'Mode': 'ro'}]
        original = copy.deepcopy(detail)
        def fingerprint(value):
            return cutover.digest(json.dumps(cutover.review_snapshot(value), sort_keys=True).encode())
        expected = fingerprint(detail)
        for ordering in itertools.permutations(detail['Mounts']):
            reordered = copy.deepcopy(detail)
            reordered['Mounts'] = list(ordering)
            self.assertEqual(fingerprint(reordered), expected)
        self.assertEqual(detail, original)
        for key, value in [('Source', '/another/private/home'), ('RW', False), ('Mode', 'ro')]:
            changed = copy.deepcopy(detail)
            changed['Mounts'][0][key] = value
            self.assertNotEqual(fingerprint(changed), expected)
        duplicated = copy.deepcopy(detail)
        duplicated['Mounts'].append(copy.deepcopy(detail['Mounts'][0]))
        self.assertNotEqual(fingerprint(duplicated), expected)
        changed_config = copy.deepcopy(detail)
        changed_config['HostConfig']['NetworkMode'] = 'host'
        self.assertNotEqual(fingerprint(changed_config), expected)

    def fixture(self, directory, engine):
        root = Path(directory)
        release = root / 'release'
        ui = release / 'ui'
        (ui / 'assets').mkdir(parents=True)
        (ui / 'index.html').write_text('old index')
        (ui / 'assets/old-lazy.js').write_text('old lazy chunk')
        compose = {'services': {
            'platform': {'image': 'mobilesci-platform:model-access-20261102',
                         'environment': {'SECRET': '${UNCHANGED_SECRET}'}},
            'provisioner': {'image': 'old-provisioner', 'environment': {
                'MANAGED_EXECUTOR_IMAGE': 'mobilesci-executor:3ad51016',
                'MANAGED_CONNECTOR_IMAGE': 'mobilesci-executor:3ad51016', 'OTHER': 'keep'}},
            'gateway': {'image': 'gateway-old', 'volumes': ['old:/html:ro']},
            'platform-db': {'image': 'database-old', 'volumes': ['db:/data']}}}
        (release / 'compose.yaml').write_text(json.dumps(compose))
        candidate = root / 'candidate'
        frozen = candidate / 'source/ui/dist'
        (frozen / 'assets').mkdir(parents=True)
        (frozen / 'index.html').write_text('new index')
        (frozen / 'assets/new-lazy.js').write_text('new lazy chunk')
        backups = root / 'backups'
        backups.mkdir()
        state = {'fingerprint': 'reviewed', 'originals': engine.originals,
                 'compose': cutover.desired_compose(compose, engine.originals[cutover.PROVISIONER]['Image']),
                 'configs': {name: cutover.desired_config(name, old) for name, old in engine.originals.items()
                             if name != cutover.GATEWAY}, 'ui': cutover.tree_hashes(frozen)}
        return release, candidate, backups, state, compose

    def execute(self, directory, engine, check=None, stale=False):
        release, candidate, backups, state, compose = self.fixture(directory, engine)
        with patch.multiple(cutover, CURRENT=release, RELEASE=release, ROOT=candidate, BACKUPS=backups), \
             patch.object(cutover, 'plan', return_value={**state, 'fingerprint': 'changed'} if stale else state), \
             patch.object(cutover, 'run', side_effect=engine.run), \
             patch.object(cutover, 'inspect', side_effect=engine.inspect), \
             patch.object(cutover, 'lookup', side_effect=lambda name: copy.deepcopy(engine.lookup(name))), \
             patch.object(cutover, 'create', side_effect=engine.create), \
             patch.object(cutover, 'assert_idle'), patch.object(cutover, 'wait_ready'), \
             patch.object(cutover, 'backup_databases'), \
             patch.object(cutover.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 20 * 1024**3})()), \
             patch.object(cutover.time, 'sleep'), \
             patch.object(cutover.subprocess, 'run', return_value=type('Result', (), {'returncode': 0})()), \
             patch.object(cutover, 'wait_public_entry'), \
             patch.object(cutover, 'public_checks', side_effect=check):
            cutover.apply(state, 'reviewed')
        return release, backups, state, compose

    def test_success_keeps_secrets_mounts_and_persists_same_future_images(self):
        engine = Engine()
        with tempfile.TemporaryDirectory() as directory:
            release, backups, state, original = self.execute(directory, engine)
            persisted = json.loads((release / 'compose.yaml').read_text())
            for name in [cutover.PLATFORM, *cutover.PRIVATE, cutover.PROVISIONER]:
                live = engine.lookup(name)
                self.assertEqual(live['HostConfig'], engine.originals[name]['HostConfig'])
                self.assertEqual(live['Mounts'], engine.originals[name]['Mounts'])
                self.assertIn('SECRET=preserve-this', live['Config']['Env'])
            provisioner = cutover.environment(engine.lookup(cutover.PROVISIONER)['Config'])
            for key in ('MANAGED_EXECUTOR_IMAGE', 'MANAGED_CONNECTOR_IMAGE'):
                self.assertEqual(provisioner[key], persisted['services']['provisioner']['environment'][key])
            self.assertEqual(persisted['services']['platform']['image'], engine.lookup(cutover.PLATFORM)['Image'])
            self.assertEqual(persisted['services']['platform-db'], original['services']['platform-db'])
            self.assertEqual(persisted['services']['gateway'], original['services']['gateway'])
            self.assertEqual(persisted['services']['platform']['environment'], original['services']['platform']['environment'])
            self.assertEqual((release / 'ui/assets/old-lazy.js').read_text(), 'old lazy chunk')
            self.assertEqual((release / 'ui/index.html').read_text(), 'new index')
            self.assertEqual(len(list(backups.glob('*/journal.json'))), 1)

    def test_every_container_creation_boundary_rolls_back_even_if_reply_is_lost(self):
        for target in [cutover.PLATFORM, *cutover.PRIVATE, cutover.PROVISIONER]:
            for lose_reply in [False, True]:
                with self.subTest(target=target, lose_reply=lose_reply), tempfile.TemporaryDirectory() as directory:
                    engine = Engine(target, lose_reply)
                    with self.assertRaisesRegex(RuntimeError, 'Injected'):
                        self.execute(directory, engine)
                    for name, old in engine.originals.items():
                        self.assertEqual(engine.lookup(name), old)
                    release = Path(directory) / 'release'
                    self.assertEqual((release / 'ui/index.html').read_text(), 'old index')
                    self.assertEqual(json.loads((release / 'compose.yaml').read_text())['services']['platform']['image'],
                                     'mobilesci-platform:model-access-20261102')

    def test_public_failure_restores_compose_static_files_and_original_container_ids(self):
        engine = Engine()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'Public validation failed'):
                self.execute(directory, engine, RuntimeError('Public validation failed'))
            for name, old in engine.originals.items():
                self.assertEqual(engine.lookup(name), old)
            release = Path(directory) / 'release'
            self.assertEqual((release / 'ui/index.html').read_text(), 'old index')
            self.assertFalse((release / 'ui/assets/new-lazy.js').exists())
            journal = json.loads(next((Path(directory) / 'backups').glob('*/journal.json')).read_text())
            self.assertEqual(journal['result'], 'rolled-back')

    def test_changed_review_fingerprint_rejects_before_external_actions(self):
        with patch.object(cutover, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'Reviewed plan changed'):
                cutover.apply({'fingerprint': 'changed'}, 'reviewed')
            run.assert_not_called()

    def test_gateway_retries_real_connection_refusal_until_listener_starts(self):
        actual_fetch = cutover.fetch
        failures = []
        with gateway_server(delayed=True) as (port, activate, requests):
            def fetch(_url, timeout=10):
                try:
                    return actual_fetch('http://127.0.0.1:' + str(port) + '/', timeout)
                except urllib.error.URLError:
                    failures.append(True)
                    activate.set()
                    raise
            with patch.object(cutover, 'fetch', side_effect=fetch), \
                 patch.object(cutover, 'inspect', return_value={'State': {'Running': True}}):
                cutover.wait_public_entry()
            self.assertTrue(failures)
            self.assertEqual(requests, ['/'])

    def test_gateway_http_rejection_is_not_treated_as_startup_delay(self):
        actual_fetch = cutover.fetch
        with gateway_server(status=403) as (port, _activate, requests):
            with patch.object(cutover, 'fetch', side_effect=lambda _url, timeout=10:
                              actual_fetch('http://127.0.0.1:' + str(port) + '/', timeout)), \
                 patch.object(cutover, 'inspect', return_value={'State': {'Running': True}}):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    cutover.wait_public_entry()
            self.assertEqual(error.exception.code, 403)
            self.assertEqual(requests, ['/'])

    def test_gateway_unavailable_wait_has_a_deadline(self):
        with patch.object(cutover, 'fetch', side_effect=urllib.error.URLError('unavailable')), \
             patch.object(cutover, 'inspect', return_value={'State': {'Running': True}}), \
             patch.object(cutover.time, 'monotonic', side_effect=[0, 0, 31, 31]), \
             patch.object(cutover.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'readiness timeout'):
                cutover.wait_public_entry()

    def test_configuration_drift_during_staging_keeps_production_running(self):
        engine = Engine()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'Plan changed while staging'):
                self.execute(directory, engine, stale=True)
            self.assertEqual(engine.calls, [])
            for name, old in engine.originals.items():
                self.assertEqual(engine.lookup(name), old)

    def test_rollback_rejects_an_unowned_gateway_before_stopping_anything(self):
        engine = Engine()
        current = copy.deepcopy(engine.lookup(cutover.GATEWAY))
        engine.lookup(cutover.GATEWAY)['Name'] = '/retained-gateway'
        current['Id'] = 'outside-operation'
        engine.items[current['Id']] = current
        with patch.object(cutover, 'lookup', side_effect=engine.lookup), \
             patch.object(cutover, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'unowned replacement'):
                cutover.rollback(Path('/unused'), {'originals': engine.originals, 'stamp': 'test'})
            run.assert_not_called()

    def test_idle_queries_use_real_run_vocabulary_and_reject_unknown_status(self):
        with sqlite3.connect(':memory:') as db:
            db.executescript('CREATE TABLE chat_queued_messages(id); CREATE TABLE chat_turn_leases(heartbeat_at);'
                             'CREATE TABLE chat_spawns(state); CREATE TABLE runs(status);')
            for status in ['done', 'failed', 'cancelled']:
                db.execute('INSERT INTO runs VALUES(?)', (status,))
            self.assertEqual([db.execute(q, (1000,) if '?' in q else ()).fetchone()[0]
                              for q in cutover.IDLE_QUERIES], [0, 0, 0, 0])
            for status in ['starting', 'running', 'unrecognized']:
                db.execute('INSERT INTO runs VALUES(?)', (status,))
            db.execute('INSERT INTO chat_turn_leases VALUES(1001)')
            db.execute('INSERT INTO chat_queued_messages VALUES(1)')
            db.execute("INSERT INTO chat_spawns VALUES('pending')")
            self.assertEqual([db.execute(q, (1000,) if '?' in q else ()).fetchone()[0]
                              for q in cutover.IDLE_QUERIES], [1, 1, 1, 3])

    def test_only_the_reviewed_ready_running_private_spaces_can_be_replaced(self):
        rows = [{'workspace_id': name.removeprefix('orx-managed-'), 'desired': 'running', 'status': 'ready'}
                for name in cutover.PRIVATE]
        cutover.validate_runtime_rows(rows)
        for key, value in [('desired', 'deleted'), ('status', 'queued'), ('status', 'starting'),
                           ('status', 'failed'), ('status', 'unknown')]:
            changed = copy.deepcopy(rows)
            changed[0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                cutover.validate_runtime_rows(changed)
        with self.assertRaisesRegex(RuntimeError, 'runtime set changed'):
            cutover.validate_runtime_rows(rows[1:])

    def test_static_conflict_and_symlink_are_rejected_before_exchange(self):
        with tempfile.TemporaryDirectory() as directory:
            release, candidate, backups, *_ = self.fixture(directory, Engine())
            frozen = candidate / 'source/ui/dist'
            (frozen / 'assets/old-lazy.js').write_text('conflicting bytes')
            with self.assertRaisesRegex(RuntimeError, 'Conflicting cached asset'):
                cutover.stage_ui(release / 'ui', frozen, backups / 'staged')
            self.assertEqual((release / 'ui/index.html').read_text(), 'old index')
            (frozen / 'secret').symlink_to(release / 'compose.yaml')
            with self.assertRaisesRegex(RuntimeError, 'Unexpected static file type'):
                cutover.tree_hashes(frozen)

    def test_failed_atomic_replace_keeps_original_content_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'compose.yaml'
            file.write_bytes(b'original')
            file.chmod(0o640)
            with patch.object(cutover.os, 'replace', side_effect=OSError('injected')):
                with self.assertRaises(OSError):
                    cutover.atomic_write(file, b'new')
            self.assertEqual(file.read_bytes(), b'original')
            self.assertEqual(file.stat().st_mode & 0o777, 0o640)
            self.assertFalse(file.with_name(file.name + '.cutover-tmp').exists())

    def test_new_public_assets_stay_readable_under_private_backup_umask(self):
        previous = os.umask(0o077)
        try:
            with tempfile.TemporaryDirectory() as directory:
                release, candidate, backups, *_ = self.fixture(directory, Engine())
                frozen = candidate / 'source/ui/dist'
                (frozen / 'new/nested').mkdir(parents=True)
                (frozen / 'new/nested/chart.svg').write_text('chart')
                staged = backups / 'staged'
                cutover.stage_ui(release / 'ui', frozen, staged)
                self.assertEqual((staged / 'new').stat().st_mode & 0o777, 0o755)
                self.assertEqual((staged / 'new/nested').stat().st_mode & 0o777, 0o755)
                self.assertEqual((staged / 'new/nested/chart.svg').stat().st_mode & 0o777, 0o644)
                self.assertEqual(backups.stat().st_mode & 0o777, 0o700)
        finally:
            os.umask(previous)

    def test_fresh_sqlite_backups_preserve_real_rows_and_reject_broken_foreign_keys(self):
        for broken in [False, True]:
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                originals = {}
                for index, name in enumerate(cutover.PRIVATE):
                    home = root / str(index)
                    state = home / 'research/state'
                    state.mkdir(parents=True)
                    with sqlite3.connect(state / 'orx.db') as db:
                        db.executescript('CREATE TABLE parent(id PRIMARY KEY);'
                                         'CREATE TABLE item(id REFERENCES parent(id));'
                                         'INSERT INTO parent VALUES(1);INSERT INTO item VALUES(1);')
                        if broken:
                            db.execute('INSERT INTO item VALUES(99)')
                    originals[name] = {'Config': {'Env': ['ORX_DATA_DIR=/home/node/research/state']},
                                       'Mounts': [{'Destination': '/home/node', 'Source': str(home)}]}
                backup = root / 'backup'
                backup.mkdir()
                def pg_command(args, **kwargs):
                    if 'stdout' in kwargs and hasattr(kwargs['stdout'], 'write'):
                        kwargs['stdout'].write(b'archive-fixture')
                    return type('Result', (), {'returncode': 0})()
                with patch.object(cutover.subprocess, 'run', side_effect=pg_command) as pg:
                    if broken:
                        with self.assertRaisesRegex(RuntimeError, 'foreign keys'):
                            cutover.backup_databases({'originals': originals}, backup)
                        pg.assert_not_called()
                    else:
                        cutover.backup_databases({'originals': originals}, backup)
                        for name in cutover.PRIVATE:
                            with sqlite3.connect(backup / (name + '.db')) as db:
                                self.assertEqual(db.execute('SELECT * FROM item').fetchall(), [(1,)])
                        self.assertEqual((backup / 'platform.dump').read_bytes(), b'archive-fixture')


if __name__ == '__main__':
    unittest.main()
