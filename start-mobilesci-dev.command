#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
export ORX_ACCOUNT_URL="${ORX_ACCOUNT_URL:-http://localhost:5300}"
export ORX_DEEP_LITERATURE_URL="${ORX_DEEP_LITERATURE_URL:-http://127.0.0.1:3000}"
export ORX_DEEP_LITERATURE_WEB_URL="${ORX_DEEP_LITERATURE_WEB_URL:-http://localhost:3000}"
# Reuse the managed development slot; copy the local database only on first start.
node scripts/dev-slot.mjs start --db copy --open "$@"
if [[ -t 0 ]]; then
  read -r -p "按回车关闭窗口（热更新开发服务将继续在后台运行）…" _mobilesci_ack
fi
