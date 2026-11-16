#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
node scripts/hosted-local.mjs stop "$@"
if [[ -t 0 ]]; then
  read -r -p "按回车关闭窗口…" _hosted_ack
fi
