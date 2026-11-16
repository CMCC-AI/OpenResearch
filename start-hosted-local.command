#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
node scripts/hosted-local.mjs start "$@"
if [[ -t 0 ]]; then
  read -r -p "按回车关闭窗口（本地托管多用户服务将继续在后台运行）…" _hosted_ack
fi
