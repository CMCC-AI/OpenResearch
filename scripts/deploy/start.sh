#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
compose=(docker compose --env-file /opt/mobilesci/state/.env -p mobilesci-remote)
"${compose[@]}" up -d --pull never platform-db
"${compose[@]}" run --rm platform-migrate
"${compose[@]}" up -d --pull never platform workbench
MOBILESCI_PREPARE_CORE=${MOBILESCI_PREPARE_CORE:-0} python3 - <<'PY'
import json,time,urllib.request,os
urls=['http://localhost:4791/api/health','http://localhost:5300/healthz']
if os.environ['MOBILESCI_PREPARE_CORE']!='1':urls.append('http://localhost:3005/api/papers?limit=1')
for url in urls:
 for attempt in range(120):
  try:
   with urllib.request.urlopen(urllib.request.Request(url,headers={'Host':'61.136.101.179:20281'} if ':5300/' in url else {}),timeout=3) as r:
    if r.status!=200: raise ValueError('HTTP status')
    if '4791' in url:
     d=json.load(r)
     if not d.get('ok') or d.get('version')!='0.2.18': raise ValueError('MobileSci version')
   break
  except Exception:
   if attempt==119: raise SystemExit('健康检查失败：'+url)
   time.sleep(2)
print('当前阶段所需服务健康检查通过。')
PY
"${compose[@]}" exec -T workbench opencode --version
# Gateway startup is deferred until the first bootstrap account is ready.
if [[ -f /opt/mobilesci/state/admin-login.txt && "${MOBILESCI_PREPARE_CORE:-0}" != 1 ]]; then
  "${compose[@]}" up -d --pull never gateway
fi
