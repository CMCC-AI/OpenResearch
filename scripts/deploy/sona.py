#!/usr/bin/env python3
"""Build a Linux/offline application bundle, SCP it, then execute the installer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
TARGET = 'ubuntu@61.136.101.179'
PORT = '20280'


def run(args, **kwargs):
    print('+', shlex.join(map(str, args)), flush=True)
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def copy_safe(source, target):
    """Follow local skill links intentionally, but reject links in uploaded archives."""
    source = source.resolve()
    if source.is_dir():
        shutil.copytree(source, target, ignore=shutil.ignore_patterns('node_modules', '.git', '*.db', '*.log', '__pycache__'))
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def validate_config(text):
    # Do not silently publish unusable macOS paths or local-only MCP endpoints.
    if '/Users/' in text or '{env:' in text or '{file:' in text:
        raise ValueError('OpenCode 配置含本机路径或环境/文件引用；请提供已转换的 --opencode-config-dir。')
    if re.search(r'https?://(?:localhost|127\.0\.0\.1|\[::1\])', text):
        raise ValueError('OpenCode MCP 指向本机回环服务；请先转换为服务器可访问地址。')
    # Local MCPs beyond the bundled CodeGraph require an explicit Linux adapter.
    commands = re.findall(r'"command"\s*:\s*\[\s*"([^"]+)"', text)
    if any(command != 'codegraph' for command in commands):
        raise ValueError('存在未打包的本地 MCP 命令；请在 Dockerfile.workbench 中加入 Linux 依赖后部署。')


def compose_text(release):
    prefix = 'sona-' + release
    return f'''name: sona-remote
services:
  platform-db:
    image: {prefix}-postgres
    environment:
      POSTGRES_DB: research_platform
      POSTGRES_USER: research_platform
      POSTGRES_PASSWORD: ${{PLATFORM_DB_PASSWORD:?}}
    ports: ['127.0.0.1:15439:5432']
    volumes: [platform_db:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD-SHELL, pg_isready -U research_platform -d research_platform]
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped
  literature-db:
    image: {prefix}-postgres
    environment:
      POSTGRES_DB: deeplit
      POSTGRES_USER: deeplit
      POSTGRES_PASSWORD: ${{POSTGRES_PASSWORD:?}}
    ports: ['127.0.0.1:15433:5432']
    volumes: [literature_db:/var/lib/postgresql/data]
    healthcheck:
      test: [CMD-SHELL, pg_isready -U deeplit -d deeplit]
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped
  platform-migrate:
    image: {prefix}-platform
    command: [node, src/admin.mjs, migrate]
    environment:
      DATABASE_URL: postgres://research_platform:${{PLATFORM_DB_PASSWORD}}@platform-db:5432/research_platform
    depends_on:
      platform-db: {{condition: service_healthy}}
  literature-migrate:
    image: {prefix}-postgres
    environment:
      PGHOST: literature-db
      PGUSER: deeplit
      PGDATABASE: deeplit
      PGPASSWORD: ${{POSTGRES_PASSWORD}}
    volumes: [./migrations:/migrations:ro]
    entrypoint: [/bin/sh, -ec]
    command:
      - 'for file in /migrations/*.sql; do psql -v ON_ERROR_STOP=1 -f "$$file"; done'
    depends_on:
      literature-db: {{condition: service_healthy}}
  platform:
    image: {prefix}-platform
    network_mode: host
    environment:
      DATABASE_URL: postgres://research_platform:${{PLATFORM_DB_PASSWORD}}@127.0.0.1:15439/research_platform
      PLATFORM_ORIGIN: http://localhost:5300
      OPENRESEARCH_APP_ORIGIN: http://localhost:4791
      DEEPLIT_ORIGIN: http://localhost:3000
      DEEPLIT_SSO_CLIENT_SECRET: ${{DEEPLIT_SSO_CLIENT_SECRET}}
      BIND_ADDRESS: 127.0.0.1
      ORX_UI_DIST: /app/ui/dist
    restart: unless-stopped
    init: true
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
  literature:
    image: {prefix}-literature
    network_mode: host
    environment:
      NODE_ENV: production
      DATABASE_URL: postgres://deeplit:${{POSTGRES_PASSWORD}}@127.0.0.1:15433/deeplit
      HOSTNAME: 127.0.0.1
      PORT: 3000
      PAPER_STORAGE_DIR: /data/papers
      DEEPLIT_AUTH_MODE: openresearch
      DEEPLIT_OPENRESEARCH_URL: http://localhost:5300
      DEEPLIT_OPENRESEARCH_PUBLIC_ORIGIN: http://localhost:5300
      DEEPLIT_OPENRESEARCH_APP_ORIGIN: http://localhost:4791
      DEEPLIT_PUBLIC_ORIGIN: http://localhost:3000
      DEEPLIT_SSO_CLIENT_SECRET: ${{DEEPLIT_SSO_CLIENT_SECRET}}
      DEEPLIT_PASSWORD_PEPPER: ${{DEEPLIT_PASSWORD_PEPPER}}
      DEEPLIT_COOKIE_MODE: same-site
      DEEPLIT_SECURE_COOKIES: 'false'
    volumes: [/opt/sona/state/papers:/data/papers]
    restart: unless-stopped
    init: true
  workbench:
    image: {prefix}-workbench
    network_mode: host
    environment:
      OPENCODE_DISABLE_AUTOUPDATE: '1'
    volumes:
      - research_home:/home/node
      - /opt/sona/state/opencode:/home/node/.config/opencode
      - /opt/sona/state/opencode-auth:/home/node/.local/share/opencode
      - /opt/sona/state/research:/home/node/research
    restart: unless-stopped
    init: true
    stop_grace_period: 2m
volumes:
  platform_db:
  literature_db:
  research_home:
'''


def download(url, target):
    print('下载部署工具：', url, flush=True)
    with urllib.request.urlopen(url, timeout=120) as response, target.open('wb') as f:
        shutil.copyfileobj(response, f)


def prepare(args):
    for binary in ('docker', 'pnpm', 'opencode', 'git'):
        if not shutil.which(binary):
            raise ValueError('缺少本地工具：' + binary)
    deep = args.deeplit_dir.resolve()
    for file in ('Dockerfile', 'db/migrations', 'package-lock.json'):
        if not (deep / file).exists():
            raise ValueError('DeepXiv 源码不完整：' + str(deep / file))
    run(['docker', 'info'], stdout=subprocess.DEVNULL)
    version = subprocess.check_output(['opencode', '--version'], text=True).strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('无法识别 OpenCode 精确版本：' + version)
    release = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + os.urandom(3).hex()
    bundle = ROOT / '.sona-run' / 'deploy' / release
    bundle.mkdir(parents=True, mode=0o700)
    config = args.opencode_config_dir.resolve()
    found = False
    for name in ('opencode.json', 'opencode.jsonc'):
        if (config / name).exists():
            text = (config / name).read_text()
            validate_config(text)
            copy_safe(config / name, bundle / 'opencode' / name)
            found = True
    if not found:
        raise ValueError('未找到 OpenCode 配置。')
    for name in ('AGENTS.md', 'skills', 'agents', 'commands', 'plugins'):
        if (config / name).exists():
            copy_safe(config / name, bundle / 'opencode' / name)
    # package-lock pins the existing OpenCode configuration dependencies.
    build = bundle / 'build'
    (build / 'opencode-package').mkdir(parents=True)
    for name in ('package.json', 'package-lock.json'):
        copy_safe(config / name, build / 'opencode-package' / name)
    for name in ('package.json', 'package-lock.json'):
        copy_safe(config / name, bundle / 'opencode' / name)
    auth = Path.home() / '.local/share/opencode/auth.json'
    if not args.without_auth:
        if auth.exists():
            copy_safe(auth, bundle / 'auth.json')
            (bundle / 'auth.json').chmod(0o600)
    else:
        # Config itself may contain keys, headers, or embedded remote credentials.
        for name in ('opencode.json', 'opencode.jsonc'):
            file = bundle / 'opencode' / name
            if file.exists() and re.search(r'(?i)(api.?key|authorization|password|token|secret|headers)', file.read_text()):
                raise ValueError('--without-auth 配置可能含凭据，请提供脱敏配置目录。')
    run(['pnpm', '--dir', ROOT / 'ui', 'install', '--frozen-lockfile'])
    run(['pnpm', '--dir', ROOT / 'ui', 'build'])
    platform = 'linux/' + args.arch
    prefix = 'sona-' + release
    run(['docker', 'buildx', 'build', '--platform', platform, '--load', '-f', ROOT / 'packages/platform/Dockerfile.executor', '--build-arg', 'OPENCODE_VERSION=' + version, '-t', 'sona-executor:bundle', ROOT])
    run(['docker', 'buildx', 'build', '--platform', platform, '--load', '-f', ROOT / 'scripts/deploy/Dockerfile.workbench', '-t', prefix + '-workbench', build])
    run(['docker', 'buildx', 'build', '--platform', platform, '--load', '-f', ROOT / 'packages/platform/Dockerfile', '-t', prefix + '-platform', ROOT])
    run(['docker', 'buildx', 'build', '--platform', platform, '--load', '-t', prefix + '-literature', deep])
    run(['docker', 'pull', '--platform', platform, 'postgres:17-alpine'])
    run(['docker', 'tag', 'postgres:17-alpine', prefix + '-postgres'])
    run(['docker', 'save', '-o', bundle / 'images.tar', *[prefix + '-' + name for name in ('workbench', 'platform', 'literature', 'postgres')]])
    # Engine and Compose binaries are also delivered, never downloaded on the server.
    engine_arch = 'x86_64' if args.arch == 'amd64' else 'aarch64'
    download(f'https://download.docker.com/linux/static/stable/{engine_arch}/docker-28.5.1.tgz', bundle / 'docker.tgz')
    compose_url = f'https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-{engine_arch}'
    download(compose_url, bundle / 'docker-compose')
    download(compose_url + '.sha256', bundle / 'compose.sha256')
    expected = (bundle / 'compose.sha256').read_text().split()[0]
    if digest(bundle / 'docker-compose') != expected:
        raise ValueError('Docker Compose 官方校验和不匹配')
    copy_safe(deep / 'db/migrations', bundle / 'migrations')
    for name in ('server.sh', 'start.sh'):
        copy_safe(ROOT / 'scripts/deploy' / name, bundle / name)
        (bundle / name).chmod(0o700)
    (bundle / 'architecture').write_text('x86_64' if args.arch == 'amd64' else 'aarch64')
    (bundle / 'opencode-version').write_text(version)
    (bundle / 'release-id').write_text(release)
    (bundle / 'compose.yaml').write_text(compose_text(release))
    manifest = {'release': release, 'architecture': platform, 'sonaCommit': subprocess.check_output(['git', '-C', ROOT, 'rev-parse', 'HEAD'], text=True).strip(), 'deepxivCommit': subprocess.check_output(['git', '-C', deep, 'rev-parse', 'HEAD'], text=True).strip(), 'opencodeVersion': version, 'credentialsIncluded': not args.without_auth and auth.exists()}
    (bundle / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    shutil.rmtree(build)
    lines = []
    for file in sorted(bundle.rglob('*')):
        if file.is_symlink():
            raise ValueError('部署包含符号链接：' + str(file))
        if file.is_file():
            file.chmod(0o700 if file.suffix == '.sh' else 0o600)
            lines.append(digest(file) + '  ' + file.relative_to(bundle).as_posix())
    (bundle / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    archive = bundle.with_suffix('.tgz')
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(bundle, arcname=release)
    archive.chmod(0o600)
    print('准备完成：', archive)
    return archive


def inspect_bundle(archive):
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        for member in members:
            p = Path(member.name)
            if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir()):
                raise ValueError('非法部署包路径或文件类型')
        roots = {Path(x.name).parts[0] for x in members}
        if len(roots) != 1:
            raise ValueError('部署包必须只有一个发布目录')
        release = roots.pop()
        if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{6}', release):
            raise ValueError('非法发布编号')
        file = tar.extractfile(release + '/manifest.json')
        manifest = json.load(file)
        if manifest.get('architecture') not in ('linux/amd64', 'linux/arm64'):
            raise ValueError('部署包架构字段非法')
        return release, manifest


def deploy(archive):
    release, manifest = inspect_bundle(archive)
    ssh = ['ssh', '-p', PORT, '-o', 'ConnectTimeout=15', TARGET]
    remote_arch = subprocess.check_output(ssh + ['uname -m'], text=True).strip()
    expected = 'x86_64' if manifest['architecture'] == 'linux/amd64' else 'aarch64'
    if remote_arch != expected:
        raise ValueError('服务器架构为 ' + remote_arch + '，请使用正确的 --arch 重新准备。')
    run(ssh + ['sudo -n true'])
    # Host key checking intentionally uses normal OpenSSH defaults, never disabled.
    remote = '.sona-upload/' + release
    run(ssh + ['umask 077; mkdir -p ' + shlex.quote(remote)])
    run(['scp', '-P', PORT, archive, TARGET + ':' + remote + '/bundle.tgz'])
    checksum = digest(archive)
    command = f'cd {remote} && printf "%s  bundle.tgz\\n" {checksum} | sha256sum -c - && tar -xzf bundle.tgz && sudo -n bash {release}/server.sh'
    run(ssh + [command])
    print('服务器部署成功。打开新终端执行以下命令，保持连接：')
    print(f'ssh -p {PORT} -N -o ExitOnForwardFailure=yes -L 4791:127.0.0.1:4791 -L 5300:127.0.0.1:5300 -L 3000:127.0.0.1:3000 {TARGET}')
    print('浏览器：http://localhost:4791；首次使用在账号页注册新账号。')
    print('本地若已有 SONA 占用这三个端口，请先停本地服务；脚本不会替你停止。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare-only', action='store_true', help='仅本地准备，可在切热点前运行')
    parser.add_argument('--bundle', type=Path, help='跳过构建，上传已准备的 .tgz')
    parser.add_argument('--arch', choices=('amd64', 'arm64'), default='amd64')
    parser.add_argument('--deeplit-dir', type=Path, default=ROOT.parent / 'DeepLiterature')
    parser.add_argument('--opencode-config-dir', type=Path, default=Path.home() / '.config/opencode')
    parser.add_argument('--sync-auth', action='store_true', help='授权向指定服务器传输 OpenCode 配置及模型登录凭据')
    parser.add_argument('--without-auth', action='store_true')
    args = parser.parse_args()
    if args.sync_auth and args.without_auth:
        parser.error('--sync-auth 与 --without-auth 互斥')
    os.umask(0o077)
    if not args.bundle and not args.without_auth and not args.sync_auth:
        answer = input('将 OpenCode 配置及模型凭据通过 SSH 传到 ubuntu@61.136.101.179，仅供该研究服务使用。输入 YES 授权：')
        if answer != 'YES':
            raise ValueError('未授权凭据传输；可使用 --without-auth 和脱敏配置。')
    archive = args.bundle.resolve() if args.bundle else prepare(args)
    if not args.prepare_only:
        _, manifest = inspect_bundle(archive)
        if args.bundle and manifest.get('credentialsIncluded') and not args.sync_auth:
            if input('该发布包含模型凭据，将传到 ubuntu@61.136.101.179。输入 YES 授权上传：') != 'YES':
                raise ValueError('未授权该发布包的凭据上传。')
        deploy(archive)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('部署停止：', error, file=sys.stderr)
        sys.exit(1)
