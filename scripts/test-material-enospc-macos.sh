#!/usr/bin/env bash
# Real disk exhaustion, confined to a fresh 32 MiB disk image.
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This runner requires macOS hdiutil. Use a dedicated small filesystem elsewhere." >&2
  exit 1
fi
cd "$(dirname "$0")/.."
enospc_dir=$(mktemp -d "${TMPDIR:-/tmp}/orx-enospc.XXXXXX")
enospc_mounted=false
cleanup() {
  enospc_status=$?
  trap - EXIT
  if "$enospc_mounted"; then
    if ! hdiutil detach "$enospc_dir/mount"; then
      echo "Detach failed; preserving test image at $enospc_dir" >&2
      exit 1
    fi
  fi
  rm -rf -- "$enospc_dir"
  exit "$enospc_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$enospc_dir/mount"
hdiutil create -size 32m -fs HFS+ -volname ORX-ENOSPC-TEST "$enospc_dir/test.dmg"
hdiutil attach "$enospc_dir/test.dmg" -nobrowse -mountpoint "$enospc_dir/mount"
enospc_mounted=true
python3 - "$enospc_dir/mount" <<'PY'
import os, sys
from pathlib import Path
mount = Path(sys.argv[1]).resolve()
assert os.stat(mount).st_dev != os.stat(mount.parent).st_dev, "not an isolated filesystem"
info = os.statvfs(mount)
assert 0 < info.f_blocks * info.f_frsize <= 64 * 1024 * 1024, "filesystem too large"
(mount / ".orx-enospc-fixture").write_text("disposable filesystem for orx ENOSPC acceptance\n")
PY
ORX_ENOSPC_TEST_ROOT="$enospc_dir/mount" cargo test --locked --bin orx \
  local::materials::tests::real_enospc_preserves_materials_and_allows_retry \
  -- --exact --ignored --nocapture
