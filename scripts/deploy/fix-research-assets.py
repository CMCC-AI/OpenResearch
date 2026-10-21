"""Compatibly redirect legacy research image URLs without restarting research.

Only the two known MobileSci gateway config mounts may be changed. Defaults to
read-only planning. Run with deployment-host write access and --apply to reload.
"""
import argparse
import datetime
import fcntl
import json
from pathlib import Path
import subprocess

TARGETS = {
    'mobilesci-remote-gateway-1': '/opt/mobilesci/current/nginx.conf',
    'cmcc-apps-gateway-1': '/opt/cmcc-apps/config/gateway-nginx.conf',
}
MARKER = '# MobileSci legacy research image paths'
ROUTES = ('    ' + MARKER + '\n'
    '    location ^~ /research-experts/ { add_header Cache-Control "no-store" always; return 302 /mobilesci$request_uri; }\n'
    '    location ^~ /research-team/ { add_header Cache-Control "no-store" always; return 302 /mobilesci$request_uri; }\n')


def candidate(old):
    if MARKER in old:
        if ROUTES not in old:
            raise RuntimeError('Unrecognized existing research image rules')
        return old
    if '/research-experts/' in old or '/research-team/' in old:
        raise RuntimeError('Existing image routing requires manual review')
    anchor = '    location / { return 404; }'
    if old.count(anchor) != 1 or 'location /mobilesci/' not in old:
        raise RuntimeError('Unrecognized gateway layout')
    return old.replace(anchor, ROUTES + anchor, 1)


def config_content(image, path, content=None):
    # Use the same Docker-owned config-file access as other deployment tools.
    # The helper has no network and can only write this already-validated mount.
    script = "const fs=require('fs');" + (
        "fs.writeFileSync('/config',fs.readFileSync(0));" if content is not None else
        "process.stdout.write(fs.readFileSync('/config','utf8'));"
    )
    result = subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'none', '--read-only', '--user', '0',
        '--mount', 'type=bind,source=' + str(path) + ',target=/config' + (',readonly' if content is None else ''),
        '--entrypoint', 'node', image, '-e', script], input=content, capture_output=True, text=True, check=True)
    return result.stdout


def main(apply=False):
    lock = (Path.home() / '.mobilesci-update.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    image = json.loads(subprocess.check_output(['docker', 'inspect', 'mobilesci-remote-platform-1'], text=True))[0]['Image']
    plans = []
    for name, file in TARGETS.items():
        detail = json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
        if not any(m['Source'] == file and m['Destination'] == '/etc/nginx/conf.d/default.conf' for m in detail['Mounts']):
            raise RuntimeError('Unexpected gateway mount: ' + name)
        path = Path(file)
        old = config_content(image, path)
        new = candidate(old)
        if old != new:
            plans.append((name, path, old, new))
    print(json.dumps({'apply': apply, 'reloadOnly': [name for name, *_ in plans]}), flush=True)
    if not apply or not plans:
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path.home() / ('.mobilesci-research-assets-fix-' + stamp)
    backup.mkdir(mode=0o700)
    for name, _, old, _ in plans:
        file = backup / (name + '.conf')
        file.write_text(old)
        file.chmod(0o600)
    changed = []
    try:
        for name, path, old, new in plans:
            changed.append((name, path, old))
            # Preserve the inode already bind-mounted in the gateway.
            config_content(image, path, new)
        for name, *_ in plans:
            subprocess.run(['docker', 'exec', name, 'nginx', '-t'], check=True)
        for name, *_ in plans:
            subprocess.run(['docker', 'exec', name, 'nginx', '-s', 'reload'], check=True)
    except BaseException:
        for _, path, old in changed:
            config_content(image, path, old)
        for name, *_ in changed:
            subprocess.run(['docker', 'exec', name, 'nginx', '-s', 'reload'], check=False)
        raise
    print('Research image compatibility applied; backup: ' + str(backup), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    main(parser.parse_args().apply)
