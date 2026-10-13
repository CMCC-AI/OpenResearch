#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
compose=(docker compose --env-file /opt/sona/state/.env -p sona-remote)
"${compose[@]}" up -d --pull never platform-db literature-db
"${compose[@]}" run --rm platform-migrate
"${compose[@]}" run --rm literature-migrate
"${compose[@]}" up -d --pull never platform literature workbench
python3 - <<'PY'
import json,time,urllib.request
urls=['http://localhost:4791/api/health','http://localhost:5300/healthz','http://localhost:3000/api/papers?limit=1']
for url in urls:
 for attempt in range(120):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'Host':'61.136.101.179:20281'} if ':5300/' in url else {}),timeout=3) as r:
    if r.status!=200: raise ValueError('HTTP status')
    if '4791' in url:
     d=json.load(r)
     if not d.get('ok') or d.get('version')!='0.2.18': raise ValueError('SONA version')
   break
  except Exception:
   if attempt==119: raise SystemExit('健康检查失败：'+url)
   time.sleep(2)
print('SONA、账号服务、DeepXiv 健康检查通过。')
PY
"${compose[@]}" exec -T workbench opencode --version
# Gateway startup is deferred until the first bootstrap account is ready.
if [[ -f /opt/sona/state/admin-login.txt ]]; then
  "${compose[@]}" up -d --pull never gateway
fi
