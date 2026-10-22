"""Preview and remove obsolete MobileSci upload archives only; never prune Docker."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time


def regular(path):
    return stat.S_ISREG(path.lstat().st_mode)


def identity(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Refusing non-regular cleanup target')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'bytes': info.st_size, 'mtimeNs': info.st_mtime_ns,
            'device': info.st_dev, 'inode': info.st_ino, 'sha256': digest.hexdigest()}


def plan(root, now=None):
    root = Path(root)
    if root.is_symlink() or not root.is_dir() or root.resolve() != root.absolute():
        raise ValueError('Cleanup root must be a real project upload directory')
    now = time.time() if now is None else now
    completed = []
    for item in root.iterdir():
        if not re.fullmatch('[0-9a-f]{16}', item.name) or item.is_symlink() or not item.is_dir():
            continue
        result = item / 'exit-code'
        if not result.exists() or not regular(result) or result.read_text().strip() != '0':
            continue
        completed.append((result.stat().st_mtime, item))
    completed.sort(key=lambda item: item[0], reverse=True)
    entries = []
    # Preserve the latest two successful packages and every unsuccessful upload.
    for completed_at, item in completed[2:]:
        if now - completed_at < 7 * 86400:
            continue
        pid = item / 'pid'
        if pid.exists():
            try:
                os.kill(int(pid.read_text().strip()), 0)
                continue
            except ProcessLookupError:
                pass
            except (OSError, ValueError):
                continue
        for name in ('bundle.tgz', 'incomplete-full-upload.tgz'):
            target = item / name
            if target.exists() and regular(target) and now - target.stat().st_mtime >= 7 * 86400:
                entries.append({'path': target.relative_to(root).as_posix(), **identity(target)})
    return {'format': 1, 'root': str(root), 'entries': entries,
            'bytes': sum(item['bytes'] for item in entries)}


def apply(root, approved):
    # Recompute eligibility and identity immediately before unlink. Directories,
    # links, logs, credentials, databases and rollback metadata are never targets.
    current = plan(root)
    if approved.get('format') != 1 or approved.get('root') != str(root):
        raise ValueError('Cleanup plan root mismatch')
    eligible = {item['path']: item for item in current['entries']}
    for item in approved.get('entries', []):
        if eligible.get(item['path']) != item:
            raise ValueError('Cleanup target changed or is no longer eligible: ' + item['path'])
    removed = []
    for item in approved.get('entries', []):
        target = root / item['path']
        if target.parent.is_symlink() or identity(target) != {key: value for key, value in item.items() if key != 'path'}:
            raise ValueError('Cleanup target changed before deletion')
        target.unlink()
        removed.append(item['path'])
    return {'removed': removed, 'bytes': sum(item['bytes'] for item in approved.get('entries', []))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True, help='Private preview JSON to write, or approved JSON to apply')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = Path.home() / '.mobilesci-updates'
    if args.apply:
        result = apply(root, json.loads(args.plan.read_text()))
    else:
        result = plan(root)
        descriptor = os.open(args.plan, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(result, output, indent=2)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
