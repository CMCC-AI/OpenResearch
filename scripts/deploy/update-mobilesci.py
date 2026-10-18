#!/usr/bin/env python3
"""Prepare/reuse a code-only MobileSci update, upload it, and safely replace two services."""
import argparse
import hashlib
import io
import json
import os
import re
from pathlib import Path, PurePosixPath, PureWindowsPath
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.mobilesci-run' / 'updates'
TARGET = 'ubuntu@61.136.101.179'
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2']


def run(args, **kwargs):
    if os.name == 'nt':
        args = [shutil.which(str(args[0])) or args[0], *args[1:]]
    print('+', shlex.join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint():
    value = hashlib.sha256()
    for name in ['Cargo.toml', 'Cargo.lock', 'build.rs', 'SYSTEM_PROMPT.md', 'SKILL.md', 'src', 'ui/src', 'ui/dist', 'linux', 'agent-skills', 'demo', 'packages/platform/Dockerfile.executor', 'packages/platform/package.json', 'packages/platform/package-lock.json', 'packages/platform/migrations', 'packages/platform/public', 'packages/platform/src', 'scripts/deploy/update-server.py', 'scripts/deploy/update-mobilesci.py', 'scripts/deploy/enable-personal-spaces.py']:
        path = ROOT / name
        for file in sorted(path.rglob('*') if path.is_dir() else [path]):
            if file.is_file():
                value.update(file.relative_to(ROOT).as_posix().encode())
                value.update(bytes.fromhex(digest(file)))
    return value.hexdigest()


def safe_extract(archive, destination):
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or PureWindowsPath(member.name).drive or '\\' in member.name or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise ValueError('不安全的部署包路径或链接：' + member.name)
    archive.extractall(destination)


def verify_bundle(bundle):
    with tarfile.open(bundle, 'r:gz') as archive:
        with tempfile.TemporaryDirectory() as temp:
            safe_extract(archive, temp)
            root = Path(temp).resolve()
            manifest = json.loads((root / 'manifest.json').read_text())
            if manifest.get('format') != 1 or manifest.get('architecture') != 'linux/amd64':
                raise ValueError('不支持的更新包格式或架构')
            for name, expected in manifest['files'].items():
                file = root / name
                if not file.resolve().is_relative_to(root) or not file.is_file() or digest(file) != expected:
                    raise ValueError('更新包校验失败：' + name)
            required = {'update-server.py', 'workbench/orx', 'workbench/Dockerfile', 'platform/Dockerfile', 'platform/dist/index.html'}
            if not required.issubset(manifest['files']):
                raise ValueError('更新包缺少必要文件')
    return manifest


def prepare(image=None):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    latest = OUTPUT / 'latest.json'
    source = fingerprint()
    if image is None and latest.exists():
        saved = json.loads(latest.read_text())
        bundle = OUTPUT / saved['file']
        if saved.get('fingerprint') == source and bundle.is_file() and digest(bundle) == saved['sha256']:
            verify_bundle(bundle)
            print('复用已准备的更新包：' + str(bundle), flush=True)
            return bundle
    if image is None:
        run(['pnpm', 'run', 'build'], cwd=ROOT / 'ui')
    with tempfile.TemporaryDirectory(prefix='mobilesci-update-') as temp:
        work = Path(temp)
        if image is None:
            archive = subprocess.check_output(['git', 'archive', 'HEAD'], cwd=ROOT)
            # Include the current deployment Dockerfile without changing the source snapshot.
            with tarfile.open(fileobj=io.BytesIO(archive)) as source_tar:
                buffer = io.BytesIO()
                with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as target_tar:
                    for member in source_tar:
                        member.pax_headers = {}
                        if member.name == 'packages/platform/Dockerfile.executor':
                            data = (ROOT / member.name).read_bytes()
                            member.size = len(data)
                            target_tar.addfile(member, io.BytesIO(data))
                        else:
                            target_tar.addfile(member, source_tar.extractfile(member) if member.isfile() else None)
                archive = buffer.getvalue()
            # Stream tracked Linux symlinks directly to Docker, including on Windows.
            run(['docker', 'build', '--platform', 'linux/amd64', '--target', 'build', '-f', 'packages/platform/Dockerfile.executor', '-t', 'mobilesci-update-build:base', '-'], input=archive)
            (work / 'Dockerfile').write_text('FROM mobilesci-update-build:base AS build\nCOPY src /src/src\nCOPY ui/dist /src/ui/dist\nCOPY ui/src/researchWorkflows.json /src/ui/src/researchWorkflows.json\nCOPY Cargo.toml Cargo.lock build.rs /src/\nCOPY linux /src/linux\nCOPY agent-skills /src/agent-skills\nCOPY demo /src/demo\nCOPY SYSTEM_PROMPT.md SKILL.md /src/\nRUN cargo build --release --locked\nFROM scratch\nCOPY --from=build /src/target/release/orx /orx\nCMD ["/orx"]\n')
            image = 'mobilesci-update-binary:' + source[:12]
            run(['docker', 'build', '--platform', 'linux/amd64', '-f', work / 'Dockerfile', '-t', image, ROOT])
            binary_path = '/orx'
        else:
            # Explicitly selected locally built image; never read remote images.
            binary_path = '/usr/local/bin/orx'
        architecture = subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{.Architecture}}'], text=True).strip()
        if architecture != 'amd64':
            raise ValueError('更新必须使用 Linux amd64 二进制')
        package = work / 'package'
        (package / 'workbench').mkdir(parents=True)
        (package / 'platform').mkdir()
        container = subprocess.check_output(['docker', 'create', '--platform', 'linux/amd64', image], text=True).strip()
        try:
            run(['docker', 'cp', container + ':' + binary_path, package / 'workbench/orx'])
        finally:
            run(['docker', 'rm', container])
        (package / 'workbench/orx').chmod(0o755)
        if (package / 'workbench/orx').read_bytes()[:4] != b'\x7fELF':
            raise ValueError('后端产物不是 Linux ELF 可执行文件')
        shutil.copytree(ROOT / 'ui/dist', package / 'platform/dist')
        shutil.copytree(ROOT / 'packages/platform/public', package / 'platform/public')
        shutil.copytree(ROOT / 'packages/platform/src', package / 'platform/src')
        shutil.copytree(ROOT / 'packages/platform/migrations', package / 'platform/migrations')
        for name in ['package.json', 'package-lock.json']:
            shutil.copy2(ROOT / 'packages/platform' / name, package / 'platform' / name)
        # Resolve Linux dependencies locally: production hosts need no registry access.
        dependencies = work / 'platform-dependencies'
        dependencies.mkdir()
        for name in ['package.json', 'package-lock.json']:
            shutil.copy2(ROOT / 'packages/platform' / name, dependencies / name)
        (dependencies / 'Dockerfile').write_text('FROM node:22-alpine AS dependencies\nWORKDIR /deps\nCOPY package.json package-lock.json ./\nRUN npm ci --omit=dev --ignore-scripts\nFROM scratch\nCOPY --from=dependencies /deps/node_modules /node_modules\nCMD ["/unused"]\n')
        dependency_image = 'mobilesci-update-platform-dependencies:' + digest(dependencies / 'package-lock.json')[:12]
        run(['docker', 'build', '--platform', 'linux/amd64', '-t', dependency_image, dependencies])
        container = subprocess.check_output(['docker', 'create', '--platform', 'linux/amd64', dependency_image], text=True).strip()
        try:
            run(['docker', 'cp', container + ':/node_modules', package / 'platform/node_modules'])
        finally:
            run(['docker', 'rm', container])
        for service in ['workbench', 'platform']:
            copy = 'COPY --chmod=755 orx /usr/local/bin/orx' if service == 'workbench' else 'WORKDIR /app/platform\nCOPY package.json package-lock.json ./\nCOPY node_modules ./node_modules\nCOPY migrations ./migrations\nCOPY dist /app/ui/dist\nCOPY public ./public\nCOPY src ./src'
            (package / service / 'Dockerfile').write_text('ARG BASE_IMAGE\nFROM ${BASE_IMAGE}\n' + copy + '\n')
        shutil.copy2(ROOT / 'scripts/deploy/update-server.py', package / 'update-server.py')
        shutil.copy2(ROOT / 'scripts/deploy/enable-personal-spaces.py', package / 'enable-personal-spaces.py')
        source = fingerprint()
        version = re.search(r'^version = "([^"]+)"', (ROOT / 'Cargo.toml').read_text(), re.MULTILINE).group(1)
        manifest = {'format': 1, 'architecture': 'linux/amd64', 'version': version, 'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'fingerprint': source, 'files': {file.relative_to(package).as_posix(): digest(file) for file in sorted(package.rglob('*')) if file.is_file()}}
        (package / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        bundle = OUTPUT / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + source[:12] + '.tgz')
        def linux_permissions(member):
            if member.name == 'workbench/orx':
                member.mode = 0o755
            return member
        with tarfile.open(bundle, 'w:gz') as archive:
            for file in sorted(package.rglob('*')):
                archive.add(file, arcname=file.relative_to(package).as_posix(), recursive=False, filter=linux_permissions)
        bundle.chmod(0o600)
        verify_bundle(bundle)
        latest.write_text(json.dumps({'file': bundle.name, 'sha256': digest(bundle), 'fingerprint': source}, indent=2) + '\n')
        latest.chmod(0o600)
        print('更新包已准备：' + str(bundle), flush=True)
        return bundle


def upload(bundle):
    verify_bundle(bundle)
    sha = digest(bundle)
    remote = '/home/ubuntu/.mobilesci-updates/' + sha[:16]
    ssh = ['ssh', *SSH_OPTIONS, '-p', '20280', TARGET]
    # Check connectivity before uploading; a failed upload may be retried safely.
    run([*ssh, 'umask 077; mkdir -p ' + shlex.quote(remote)])
    run(['scp', *SSH_OPTIONS, '-P', '20280', bundle, TARGET + ':' + remote + '/bundle.tgz'])
    # Verify the outer archive before executing anything from it. Extraction is
    # limited to regular files and directories, with traversal/links rejected.
    bootstrap = '''import hashlib,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]); archive=root/'bundle.tgz'
if hashlib.sha256(archive.read_bytes()).hexdigest()!=sys.argv[2]: raise SystemExit('上传 SHA256 不匹配')
with tarfile.open(archive,'r:gz') as tar:
 for entry in tar.getmembers():
  path=pathlib.Path(entry.name)
  if path.is_absolute() or '..' in path.parts or not(entry.isfile() or entry.isdir()): raise SystemExit('不安全的部署包')
 tar.extractall(root)
'''
    launcher = """import fcntl,os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parent
lock=(root/'launcher.lock').open('a')
try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: sys.exit(0)
if (root/'exit-code').exists() and (root/'exit-code').read_text().strip()=='0': sys.exit(0)
(root/'pid').write_text(str(os.getpid()))
(root/'exit-code').unlink(missing_ok=True)
with (root/'deploy.log').open('w') as log:
 code=subprocess.call(['python3','-u',str(root/'update-server.py')],stdout=log,stderr=subprocess.STDOUT)
(root/'exit-code.tmp').write_text(str(code))
(root/'exit-code.tmp').replace(root/'exit-code')
"""
    # Extract first, then run detached so switching networks cannot kill a
    # container replacement midway. Re-running reattaches to the same package.
    setup = 'python3 -c ' + shlex.quote(bootstrap) + ' ' + shlex.quote(remote) + ' ' + shlex.quote(sha)
    write_launcher = 'python3 -c ' + shlex.quote('import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(sys.argv[2])') + ' ' + shlex.quote(remote + '/launcher.py') + ' ' + shlex.quote(launcher)
    start = 'nohup python3 ' + shlex.quote(remote + '/launcher.py') + ' </dev/null >/dev/null 2>&1 &'
    run([*ssh, setup + ' && ' + write_launcher + ' && { ' + start + ' }'])
    print('服务器后台更新已启动；网络断开后可重新执行同一命令查看结果。', flush=True)
    offset = 0
    monitor = """import json,pathlib,sys
root=pathlib.Path(sys.argv[1]); offset=int(sys.argv[2]); log=root/'deploy.log'
text=''
if log.exists():
 with log.open() as file:
  file.seek(offset); text=file.read(); offset=file.tell()
result=root/'exit-code'
print(json.dumps({'log':text,'offset':offset,'code':int(result.read_text()) if result.exists() else None}))
"""
    while True:
        response = subprocess.check_output([*ssh, 'python3 -c ' + shlex.quote(monitor) + ' ' + shlex.quote(remote) + ' ' + str(offset)], text=True)
        progress = json.loads(response)
        print(progress['log'], end='', flush=True)
        offset = progress['offset']
        if progress['code'] is not None:
            if progress['code'] != 0:
                raise ValueError('服务器更新失败；请查看上述日志。旧容器按失败恢复流程保留。服务器日志：' + remote + '/deploy.log')
            break
        time.sleep(5)
    print('更新完成：http://61.136.101.179:20281/mobilesci/\n请刷新页面；必要时强制刷新浏览器缓存。', flush=True)


def main():
    parser = argparse.ArgumentParser(description='只更新 MobileSci 科研后端和前端，保留线上配置、数据库、模型凭据和文献服务。')
    parser.add_argument('--prepare-only', action='store_true', help='只准备本地更新包，不连接服务器')
    parser.add_argument('--bundle', type=Path, help='使用指定的已准备更新包')
    parser.add_argument('--workbench-image', help='从指定的本地 Linux amd64 科研镜像提取二进制')
    args = parser.parse_args()
    if args.bundle and args.workbench_image:
        parser.error('--bundle 与 --workbench-image 不能同时使用')
    os.chdir(ROOT)
    bundle = args.bundle.resolve() if args.bundle else prepare(args.workbench_image)
    if not args.prepare_only:
        upload(bundle)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit('更新未完成：' + str(error) + '\n切换到可连接服务器的网络后，重新执行同一命令即可；本地包会保留。')
