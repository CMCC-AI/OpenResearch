#!/bin/sh
# Install the same offline tool bundle into fresh and existing Debian 12 images.
set -eu
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. /etc/os-release
test "$ID:$VERSION_ID" = debian:12 || {
  echo 'Executor tools require a Debian 12 base image' >&2
  exit 1
}
# apt orders Pre-Depends (notably python3-minimal) and resolves only local debs.
# The bundle includes the entire dependency closure, including older-base upgrades.
mkdir -p "$bundle/lists/partial"
DEBIAN_FRONTEND=noninteractive apt-get \
  -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=- \
  -o Dir::State::lists="$bundle/lists" \
  install -y --no-remove --no-install-recommends "$bundle"/debs/*.deb
install -m 755 "$bundle/bin/uv" "$bundle/bin/uvx" /usr/local/bin/
install -m 755 "$bundle/prepare.sh" /usr/local/bin/orx-prepare-executor
install -m 755 "$bundle/check.sh" /usr/local/bin/orx-check-executor-tools
orx-prepare-executor
