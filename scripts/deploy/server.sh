#!/usr/bin/env bash
set -euo pipefail
umask 077
phase=${1:-finish}
bundle=$(cd "$(dirname "$0")" && pwd)
root=/opt/sona
[[ $(id -u) == 0 ]] || { echo '请通过 sudo 执行服务器安装阶段。' >&2; exit 1; }
exec 9>/var/lock/sona-deploy.lock
flock -n 9 || { echo '已有部署在执行。' >&2; exit 1; }
cd "$bundle"
sha256sum -c SHA256SUMS
[[ $(uname -m) == "$(cat architecture)" ]] || { echo 'CPU 架构不匹配，请按服务器架构重新打包。' >&2; exit 1; }
. /etc/os-release
[[ $ID == ubuntu ]] || { echo '目前仅支持 Ubuntu/systemd 服务器。' >&2; exit 1; }
command -v python3 >/dev/null
if ! command -v docker >/dev/null; then
  # Docker static binaries are prepared locally; host networking needs iptables.
  if ! command -v iptables >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y iptables ca-certificates
  fi
  tar -xzf docker.tgz -C /usr/local/bin --strip-components=1
  install -m 0755 docker-compose /usr/local/bin/docker-compose
  install -d /usr/local/lib/docker/cli-plugins
  ln -sf /usr/local/bin/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
  cat >/etc/systemd/system/docker.service <<'UNIT'
[Unit]
Description=Docker Engine for SONA
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/dockerd
Restart=on-failure
Delegate=yes
KillMode=process
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now docker
else
  if ! docker compose version >/dev/null 2>&1; then
    install -d /usr/local/lib/docker/cli-plugins
    install -m 0755 docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
  fi
  systemctl start docker
fi
docker info >/dev/null
install -d -m 0700 "$root" "$root/releases" "$root/state" "$root/backups"
release="$root/releases/$(cat release-id)"
if [[ -e $release ]]; then
  cmp -s "$bundle/manifest.json" "$release/manifest.json" || { echo '发布编号碰撞，请重新打包。' >&2; exit 1; }
fi
install -d -m 0700 "$release"
cp -a compose.yaml images.tar manifest.json migrations start.sh nginx.conf "$release/"
chmod 0700 "$release/start.sh"
# Stable secrets survive upgrades; never copy local database or account credentials.
if [[ ! -f $root/state/.env ]]; then
  python3 - "$root/state/.env" <<'PY'
import secrets,sys
with open(sys.argv[1],'x') as f:
 for k in ('PLATFORM_DB_PASSWORD','POSTGRES_PASSWORD','DEEPLIT_SSO_CLIENT_SECRET','DEEPLIT_PASSWORD_PEPPER'):
  f.write(k+'='+secrets.token_hex(32)+'\n')
PY
fi
install -d -m 0755 "$root/state/opencode" "$root/state/opencode-auth" "$root/state/papers" "$root/state/research"
# Back up previous configuration without destroying persistent volumes.
if [[ -L $root/current ]]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  tar -czf "$root/backups/config-$stamp.tgz" -C "$root/state" .env opencode opencode-auth
  old=$(readlink -f "$root/current")
  cd "$old"
  docker compose --env-file "$root/state/.env" -p sona-remote exec -T platform-db pg_dump -U research_platform research_platform >"$root/backups/platform-$stamp.sql"
  # Active research blocks redeployment; no forced cancellation.
  python3 - <<'PY'
import json,urllib.request
v=json.load(urllib.request.urlopen('http://localhost:4791/api/projects/activity'))
if any(x['activeAgents'] or x['runningExperiments'] for x in v['activity']):
 raise SystemExit('存在运行中的研究，部署停止；请完成任务后重试。')
PY
  python3 - "$root/state/research/state/orx.db" "$root/backups/research-$stamp.db" <<'PYDB'
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
if c.execute('select count(*) from chat_queued_messages').fetchone()[0]:
 raise SystemExit('存在待执行消息，部署停止。')
c.backup(sqlite3.connect(sys.argv[2]))
PYDB
fi
cp -a "$bundle/opencode/." "$root/state/opencode/"
if [[ -f $bundle/auth.json ]]; then install -m 0600 "$bundle/auth.json" "$root/state/opencode-auth/auth.json"; fi
chown -R 1000:1000 "$root/state/opencode" "$root/state/opencode-auth" "$root/state/research"
chown -R 1001:1001 "$root/state/papers"
docker load -i "$release/images.tar"
cd "$release"
# A container with host networking must not be replaced by another image tag accidentally.
if [[ -L $root/current ]]; then
  docker compose --env-file "$root/state/.env" -p sona-remote stop workbench
fi
if ! SONA_PREPARE_CORE=1 ./start.sh; then
  echo "启动失败。日志：cd $release && docker compose --env-file $root/state/.env -p sona-remote logs --tail 80" >&2
  echo '数据卷保持原样；数据库迁移后请勿自动恢复旧数据库。' >&2
  exit 1
fi
# Bootstrap a single authorized account before opening the public gateway.
if [[ ! -f $root/state/admin-login.txt ]]; then
  python3 - "$root/state/admin-password" <<'ADMIN'
import secrets,sys
from pathlib import Path
p=Path(sys.argv[1])
if not p.exists(): p.write_text(secrets.token_urlsafe(32)+'\n')
ADMIN
  docker compose --env-file "$root/state/.env" -p sona-remote run --rm -T platform-migrate node src/admin.mjs create-user owner@research.local 科研平台管理员 <"$root/state/admin-password"
  { printf '入口：http://61.136.101.179:20281/sona\n账号：owner@research.local\n密码：'; cat "$root/state/admin-password"; } >"$root/state/admin-login.txt"
fi
if ! command -v ssh-keygen >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-client
fi
if [[ ! -f $root/state/literature-tunnel ]]; then
  ssh-keygen -q -t ed25519 -N '' -f "$root/state/literature-tunnel" -C sona-literature-only
fi
if [[ $phase == prepare ]]; then
  echo 'SONA core prepared. Waiting for literature peer and restricted tunnel.'
  exit 0
fi
# Run a bundled Nginx, keeping the host's existing sites untouched.
docker compose --env-file "$root/state/.env" -p sona-remote run --rm --no-deps gateway nginx -t
docker compose --env-file "$root/state/.env" -p sona-remote up -d --pull never gateway
python3 - <<'PUBLIC'
import urllib.request,urllib.error,time
u='http://127.0.0.1:20281'
headers={'Host':'61.136.101.179:20281'}
for attempt in range(30):
 try:
  urllib.request.urlopen(urllib.request.Request(u+'/api/health',headers=headers),timeout=3)
  break
 except Exception:
  if attempt==29: raise SystemExit('Nginx 20281 未就绪，请检查是否被现有服务占用。')
  time.sleep(1)
for path in ('/api/health','/sona/','/sona/projects','/_account/login','/api/papers?limit=1'):
 with urllib.request.urlopen(urllib.request.Request(u+path,headers=headers),timeout=10) as r:
  assert r.status==200
try:
 urllib.request.urlopen(urllib.request.Request(u+'/api/projects',headers=headers),timeout=10)
 raise SystemExit('科研 API 未登录保护校验失败')
except urllib.error.HTTPError as e:
 if e.code not in (401,403): raise
print('Nginx 20281 入口与科研 API 登录保护检查通过。')
PUBLIC
ln -sfn "$release" "$root/current"
cat >/etc/systemd/system/sona.service <<UNIT
[Unit]
Description=SONA research services
Requires=docker.service sona-literature-tunnel.service
After=docker.service sona-literature-tunnel.service network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$root/current
ExecStart=$root/current/start.sh
ExecStop=/usr/local/bin/docker-compose --env-file $root/state/.env -p sona-remote stop
TimeoutStartSec=900
[Install]
WantedBy=multi-user.target
UNIT
# Existing Docker may expose compose only as a plugin, so ExecStop uses a wrapper.
cat >"$root/compose" <<'WRAP'
#!/bin/sh
exec docker compose "$@"
WRAP
chmod 0700 "$root/compose"
sed -i "s|ExecStop=/usr/local/bin/docker-compose |ExecStop=$root/compose |" /etc/systemd/system/sona.service
systemctl daemon-reload
systemctl enable sona.service
systemctl start sona.service
printf '部署完成。SONA 0.2.18；OpenCode %s\n' "$(cat "$bundle/opencode-version")"
echo '公网入口：http://61.136.101.179:20281/sona；内部服务端口仅监听回环地址。'
