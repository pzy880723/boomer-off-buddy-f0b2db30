#!/usr/bin/env bash
set -euo pipefail
base=/var/www/boomer-erp
old="$base/releases/listing-summary-90d6633-20261005"
release="${ASSET_RELEASE_DIR:?Missing ASSET_RELEASE_DIR}"
[[ "$release" =~ ^/var/www/boomer-erp/releases/member-assets-[a-f0-9]{7,40}-20261005$ ]]
[[ "$(readlink -f "$base/current")" == "$old" ]]
[[ ! -e "$release" ]]
mkdir -p "$release"
tar -C "$old" --exclude=node_modules --exclude=.output --exclude=dist --exclude=.git --exclude=.env --exclude='.env.*' --exclude='._*' -cf - . | tar -C "$release" -xf -
# Nitro mutates dependency metadata during build; don't share the active release's dependencies.
cp -a "$old/node_modules" "$release/node_modules"
ln -s "$old/.env" "$release/.env"
tar -C "$release" -xf /tmp/boomer-member-assets.tar
cd "$release"
node_modules/.bin/esbuild scripts/run-youzan-asset-observer.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/.youzan-asset-observer.mjs
npm run build:tencent > /tmp/boomer-member-assets-build.log 2>&1
printf 'Candidate built: %s\n' "$release"
