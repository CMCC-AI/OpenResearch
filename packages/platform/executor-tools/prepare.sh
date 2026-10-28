#!/bin/sh
# Run at image build time, after any root-owned OpenCode/npm invocations.
set -eu
test ! -L /tmp/opencode || {
  echo '/tmp/opencode must be a real directory' >&2
  exit 1
}
install -d -m 700 -o 1000 -g 1000 /tmp/opencode
chown -hR 1000:1000 /tmp/opencode
