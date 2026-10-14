#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
node scripts/start-mobilesci.mjs "$@"
if [[ -t 0 ]]; then
  read -r -p "按回车关闭启动窗口（MobileSci 将继续在后台运行）…" _mobilesci_ack
fi
