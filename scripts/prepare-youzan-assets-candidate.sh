#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="${ASSET_PREVIOUS_DIR:?Missing ASSET_PREVIOUS_DIR}"
[[ "$old" =~ ^/var/www/boomer-erp/releases/[a-z0-9-]+$ ]]
release="${ASSET_RELEASE_DIR:?Missing ASSET_RELEASE_DIR}"
[[ "$release" =~ ^/var/www/boomer-erp/releases/member-assets-[a-f0-9]{7,40}-20261005$ ]]
[[ "$(readlink -f "$base/current")" == "$old" ]]
[[ ! -e "$release" ]]
if tar -tf /tmp/boomer-member-assets.tar | grep -E '^(\./)?\.env($|\.)' > /dev/null; then
  printf 'release_archive_contains_environment\n' >&2
  exit 1
fi
mkdir -p "$release"
tar -C "$old" --exclude=node_modules --exclude=.output --exclude=dist --exclude=.git --exclude=.env --exclude='.env.*' --exclude='._*' -cf - . | tar -C "$release" -xf -
# Nitro mutates dependency metadata during build; don't share the active release's dependencies.
cp -a "$old/node_modules" "$release/node_modules"
ln -s "$old/.env" "$release/.env"
tar -C "$release" -xf /tmp/boomer-member-assets.tar
cd "$release"
node_modules/.bin/esbuild scripts/run-youzan-asset-observer.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/.youzan-asset-observer.mjs
node_modules/.bin/esbuild scripts/run-youzan-points-canary.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/.youzan-points-canary.mjs
npm run build:tencent > "$release/build-tencent.log" 2>&1
printf 'Candidate built: %s\n' "$release"
