"""Enable quota model administration on the MobileSci replica; default is a plan.

Stage contains platform/src/{server,model-gateway,quota-model-settings}.mjs and
ui/dist. --apply backs up configuration, removes GLM from the active registry,
replaces only the platform, preserves accounting and executor HOME volumes,
and persists the same writable-directory normalization in Compose.
"""
import argparse
import copy
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

spec = importlib.util.spec_from_file_location('runtime_deploy', Path(__file__).with_name('update-runtime-pool.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
PLATFORM = runtime.PLATFORM
CURRENT = runtime.CURRENT
DIRECTORY = Path('/opt/mobilesci/state/token-quotas')
TARGET = '/run/mobilesci/token-quotas'
FILES = {'src/server.mjs': '589bfd4dec518d9ae2700cc66ae7c142cdfcce7e2a0563ceb7c04685f330c039',
         'src/model-gateway.mjs': '211c0c08de68187c199014a28fda51eb0a0cc83b2f7acc45148470b3cbd665fd'}


def desired(config, host, image):
    config, host = copy.deepcopy(config), copy.deepcopy(host)
    config['Image'] = image
    env = runtime.environment(config)
    env['TOKEN_QUOTA_MODELS_FILE'] = TARGET + '/models.json'
    config['Env'] = [k + '=' + v for k, v in env.items()]
    host['Binds'] = [b for b in host.get('Binds', []) if b.split(':')[1] != '/run/mobilesci/token-quota-models.json']
    host['Binds'].append(str(DIRECTORY) + ':' + TARGET + ':rw')
    return config, host


def desired_compose(compose, image):
    result = copy.deepcopy(compose)
    platform = result['services']['platform']
    platform['image'] = image
    platform['environment']['TOKEN_QUOTA_MODELS_FILE'] = TARGET + '/models.json'
    platform['volumes'] = [v for v in platform.get('volumes', []) if (v.get('target') if isinstance(v, dict) else v.split(':')[1]) != '/run/mobilesci/token-quota-models.json']
    platform['volumes'].append({'type': 'bind', 'source': str(DIRECTORY), 'target': TARGET, 'read_only': False})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    lock = (Path('/opt/mobilesci/state/update.lock')).open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stage = args.stage.resolve()
    old = runtime.inspect(PLATFORM)
    if old['Config']['Labels'].get('com.docker.compose.project') != 'mobilesci-replica':
        raise RuntimeError('Unexpected deployment ownership')
    for path, expected in FILES.items():
        if hashlib.sha256(runtime.run('docker', 'exec', PLATFORM, 'cat', path)).hexdigest() != expected:
            raise RuntimeError('Production source changed: ' + path)
    models_file = DIRECTORY / 'models.json'
    document = json.loads(models_file.read_bytes())
    retained = [m for m in document['models'] if m.get('providerId') == 'moonshotai-cn' and m['model'].startswith('kimi-')]
    if not retained or any('glm' not in m['model'].lower() for m in document['models'] if m not in retained):
        raise RuntimeError('Unexpected model registry; review before applying')
    print(json.dumps({'models': [m['id'] for m in retained], 'default': retained[0]['id'], 'platformOnly': True, 'apply': args.apply}), flush=True)
    if not args.apply:
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/opt/mobilesci/backups') / ('quota-model-admin-' + stamp)
    backup.mkdir(mode=0o700)
    (backup / 'container.json').write_text(json.dumps(old))
    for source, target in [(models_file, 'models.json'), (CURRENT / 'compose.yaml', 'compose.yaml'), (CURRENT / 'ui/index.html', 'index.html')]:
        shutil.copy2(source, backup / target)
        (backup / target).chmod(0o600)
    (backup / 'directory.json').write_text(json.dumps({'uid': DIRECTORY.stat().st_uid, 'gid': DIRECTORY.stat().st_gid, 'mode': DIRECTORY.stat().st_mode & 0o777}))
    context = stage / 'build'
    context.mkdir(exist_ok=True)
    for name in ['server.mjs', 'model-gateway.mjs', 'quota-model-settings.mjs']:
        shutil.copy2(stage / 'platform/src' / name, context / name)
    base = 'mobilesci-quota-model-admin-base:' + stamp.lower()
    runtime.run('docker', 'tag', old['Image'], base)
    (context / 'Dockerfile').write_text('FROM ' + base + '\nCOPY server.mjs model-gateway.mjs quota-model-settings.mjs /app/platform/src/\n')
    image = 'mobilesci-quota-model-admin:' + stamp.lower()
    runtime.run('docker', 'build', '--pull=false', '-t', image, str(context))
    compose = desired_compose(json.loads((CURRENT / 'compose.yaml').read_bytes()), image)
    candidate = stage / 'compose.model-admin.json'
    candidate.write_text(json.dumps(compose, indent=2) + '\n')
    runtime.run('docker', 'compose', '--env-file', '/dev/null', '--project-directory', str(CURRENT), '-f', str(candidate), 'config', '--quiet')
    # Existing executor research must be idle before interrupting gateway connections.
    idle_spec = importlib.util.spec_from_file_location('idle_check', Path(__file__).with_name('enable-opencode-admin.py'))
    idle = importlib.util.module_from_spec(idle_spec)
    idle_spec.loader.exec_module(idle)
    names = runtime.run('docker', 'ps', '--filter', 'label=openresearch.managed=true', '--format', '{{.Names}}').decode().split()
    idle.assert_idle(names)
    renamed = False
    replacement = False
    previous = PLATFORM + '-before-model-admin-' + stamp.lower()
    try:
        runtime.run('docker', 'stop', '-t', '120', PLATFORM)
        for name in names:
            runtime.run('docker', 'stop', '-t', '30', name)
        runtime.run('docker', 'rename', PLATFORM, previous)
        renamed = True
        DIRECTORY.chmod(0o700)
        os.chown(DIRECTORY, 1000, 1000)
        document['models'] = retained
        runtime.atomic(models_file, (json.dumps(document, indent=2) + '\n').encode())
        os.chown(models_file, 1000, 1000)
        config, host = desired(old['Config'], old['HostConfig'], image)
        runtime.create(PLATFORM, config, host)
        replacement = True
        runtime.run('docker', 'start', PLATFORM)
        runtime.wait_health()
        for name in names:
            runtime.run('docker', 'start', name)
        # Exercise the exact backend's atomic write path using the unchanged default.
        code = "import {quotaModelSettings} from './src/quota-model-settings.mjs'; const s=quotaModelSettings(process.env.TOKEN_QUOTA_MODELS_FILE); let r=await s.read(); r=await s.default({id:r.models[0].id,revision:r.revision}); console.log(JSON.stringify({backend:r.backend,models:r.models.map(m=>m.id)}))"
        summary = json.loads(runtime.run('docker', 'exec', PLATFORM, 'node', '--input-type=module', '-e', code))
        if summary['models'] != [m['id'] for m in retained]:
            raise RuntimeError('Effective model verification failed')
        for source in (stage / 'ui/dist').rglob('*'):
            if source.is_file() and source.name != 'index.html':
                target = CURRENT / 'ui' / source.relative_to(stage / 'ui/dist')
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists(): runtime.atomic(target, source.read_bytes(), 0o644)
                elif target.read_bytes() != source.read_bytes(): raise RuntimeError('Static asset conflict')
        runtime.atomic(CURRENT / 'ui/index.html', (stage / 'ui/dist/index.html').read_bytes(), 0o644)
        runtime.atomic(CURRENT / 'compose.yaml', candidate.read_bytes())
        runtime.health()
        result = {'healthy': True, 'backup': str(backup), **summary}
        (backup / 'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    except Exception:
        if replacement: runtime.run('docker', 'rm', '-f', PLATFORM)
        runtime.atomic(models_file, (backup / 'models.json').read_bytes(), 0o400)
        os.chown(models_file, 1000, 1000)
        directory = json.loads((backup / 'directory.json').read_text())
        os.chown(DIRECTORY, directory['uid'], directory['gid'])
        DIRECTORY.chmod(directory['mode'])
        if renamed:
            # Recreate the original single-file mount so it sees the restored inode.
            runtime.run('docker', 'rm', previous)
            runtime.create(PLATFORM, old['Config'], old['HostConfig'])
            runtime.run('docker', 'start', PLATFORM)
        elif not runtime.inspect(PLATFORM)['State']['Running']:
            runtime.run('docker', 'start', PLATFORM)
        runtime.atomic(CURRENT / 'compose.yaml', (backup / 'compose.yaml').read_bytes())
        runtime.atomic(CURRENT / 'ui/index.html', (backup / 'index.html').read_bytes(), 0o644)
        runtime.wait_health()
        for name in names:
            runtime.run('docker', 'start', name)
        raise


if __name__ == '__main__':
    main()
