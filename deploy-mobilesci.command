#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
# This deployment target is authorized to receive the local model credentials.
# --without-auth remains an explicit opt-out for a sanitized configuration.
sync_auth=1
for arg in "$@"; do
  if [[ "$arg" == --without-auth || "$arg" == --sync-auth || "$arg" == --help || "$arg" == -h ]]; then
    sync_auth=0
  fi
done
if [[ "$sync_auth" == 1 ]]; then
  exec python3 scripts/deploy/mobilesci.py --sync-auth "$@"
fi
exec python3 scripts/deploy/mobilesci.py "$@"
