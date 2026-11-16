#!/bin/sh
# Run at image build time, after any root-owned OpenCode/npm invocations.
set -eu
for cache in /tmp/opencode /home/node/.npm; do
  test ! -L "$cache" || {
    echo "$cache must be a real directory" >&2
    exit 1
  }
  install -d -m 700 -o 1000 -g 1000 "$cache"
  chown -hR 1000:1000 "$cache"
done
