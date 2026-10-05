#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="${SUPPORT_PREVIOUS_DIR:?Missing SUPPORT_PREVIOUS_DIR}"
release="${SUPPORT_RELEASE_DIR:?Missing SUPPORT_RELEASE_DIR}"
[[ "$old" =~ ^/var/www/boomer-erp/releases/[a-z0-9-]+$ ]]
[[ "$release" =~ ^/var/www/boomer-erp/releases/support-[a-f0-9]{7,40}-[0-9]{8}$ ]]
[[ "$(readlink -f "$base/current")" == "$old" ]]
[[ ! -e "$release" ]]
if tar -tf /tmp/boomer-support.tar | grep -E '(^|/)\.env($|\.)' > /dev/null; then
  printf 'release_archive_contains_environment\n' >&2
  exit 1
fi
mkdir -p "$release"
tar -C "$old" --exclude=node_modules --exclude=.output --exclude=dist --exclude=.git --exclude=.env --exclude='.env.*' --exclude='._*' -cf - . | tar -C "$release" -xf -
# Some releases symlink their dependencies; materialize a private copy before Nitro mutates them.
cp -a "$(readlink -f "$old/node_modules")" "$release/node_modules"
ln -s "$old/.env" "$release/.env"
tar -C "$release" -xf /tmp/boomer-support.tar
cd "$release"
npm run build:tencent > "$release/build-tencent.log" 2>&1
printf 'Candidate built: %s\n' "$release"
