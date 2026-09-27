import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

const path = new URL('./deploy-product-sale-repair-20260927.sh', import.meta.url);
const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
const fn = name => {
  const found = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(found, `${name} must exist`); return found[0];
};
test('new deployment supports independent prepare and publish and exact release pair', () => {
  assert.match(source, /prepare\|publish/);
  assert.match(source, /old="\$base\/releases\/listing-image-recovery-20260927"/);
  assert.match(source, /release="\$base\/releases\/product-sale-repair-20260927"/);
});
for (const target of ['/old', '/new']) for (const inherited of ['', 'false', 'true']) {
  test(`${target} explicitly enables fenced image worker even with inherited ${JSON.stringify(inherited)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'product-sale-start-'));
    try {
      const capture = join(dir, 'env');
      writeFileSync(join(dir, 'pm2'), '#!/bin/bash\nprintf "%s|%s|%s" "$HANDHELD_LISTING_IMAGE_WORKER_ENABLED" "$ERP_PORT" "$APP_DIR" > "$CAPTURE"\n', { mode: 0o755 });
      const r = spawnSync('bash', ['-c', `set -euo pipefail\n${fn('start_production')}\nstart_production ${target}`], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, HANDHELD_LISTING_IMAGE_WORKER_ENABLED: inherited },
      });
      assert.equal(r.status, 0, r.stderr); assert.equal(readFileSync(capture, 'utf8'), `true|3005|${target}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test('prepare copies existing dependencies and runs tests before build, guards before stamp', () => {
  const prepare = source.split('  prepare)')[1]?.split('  publish)')[0] ?? '';
  assert.match(prepare, /cp -a "\$old\/\." "\$release\/"/);
  assert.ok(prepare.indexOf('run_regressions') < prepare.indexOf('npm run build:tencent'));
  assert.ok(prepare.indexOf('verify_candidate') < prepare.indexOf('> "$stamp"'));
  assert.doesNotMatch(source, /npm (?:ci|install)|workers\.env.*(?:install|cp)|systemctl[^\n]*boomer-youzan-sync\./);
});
test('candidate authenticates order guard only on port3006; production check is anonymous', () => {
  assert.match(fn('verify_candidate'), /verify_order_guard http:\/\/127\.0\.0\.1:3006 candidate/);
  assert.match(source, /verify_order_guard https:\/\/erp\.boomeroff\.com public/);
});
test('publish confirms reviewed migrations and installs new timer only after public verification', () => {
  const publish = source.split('  publish)')[1] ?? '';
  assert.match(publish, /PRODUCT_SALE_MIGRATIONS_CONFIRMED/);
  assert.ok(publish.indexOf('verify_public https:') < publish.indexOf('install_order_timer'));
  assert.ok(publish.indexOf('ln -sfn "$release"') < publish.indexOf('install_order_timer'));
  assert.ok(publish.indexOf('install_order_timer') < publish.indexOf('rollback=0'));
});
test('failed publish stops new timer and service before restoring old process', () => {
  const cleanup = fn('publish_cleanup');
  assert.ok(cleanup.indexOf('systemctl disable --now "$order_timer"') < cleanup.indexOf('start_production "$old"'));
  assert.ok(cleanup.indexOf('systemctl stop "$order_service"') < cleanup.indexOf('start_production "$old"'));
  assert.doesNotMatch(cleanup, /HANDHELD_LISTING_IMAGE_WORKER_ENABLED=false/);
});

for (const variant of ['valid', 'env', 'xattr', 'missing', 'symlink']) test(`archive allowlist ${variant}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-sale-archive-'));
  try {
    const required = source.match(/required_files=\(\n([\s\S]*?)\n\)/)[1].trim().split(/\s+/);
    assert.equal(required.length, 22);
    const entries = variant === 'missing' ? required.slice(1) : [...required];
    if (variant === 'env') entries.push('.env');
    if (variant === 'xattr') entries.push('src/lib/._image.ts');
    const fixture = join(dir, 'files'); mkdirSync(fixture);
    for (const entry of entries) {
      const path = join(fixture, entry); mkdirSync(dirname(path), { recursive: true });
      if (variant === 'symlink' && entry === required[0]) symlinkSync('/tmp/forbidden-target', path);
      else writeFileSync(path, 'fixture');
    }
    const archive = join(dir, 'archive.tar.gz');
    const packed = spawnSync('tar', ['-czf', archive, '-C', fixture, ...entries], { env: { ...process.env, COPYFILE_DISABLE: '1' }, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const r = spawnSync('bash', ['-c', `set -euo pipefail\narchive='${archive}'\nrequired_files=(${required.join(' ')})\n${fn('check_archive')}\ncheck_archive`], { encoding: 'utf8' });
    assert.equal(r.status === 0, variant === 'valid', r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const fail of ['none', 'first-install', 'second-install', 'enable', 'active']) test(`timer installation ${fail} keeps rollback armed until verified`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-sale-rollback-'));
  try {
    const trace = join(dir, 'trace');
    const setup = `set -euo pipefail
trace='${trace}'
old=/old
base=/base
candidate=candidate
worker_hash=/unchanged-hash
order_service=boomer-youzan-order-sync.service
order_timer=boomer-youzan-order-sync.timer
unit_dir=/mock-units
rollback=1
order_units_touched=1
installs=0
install(){ installs=$((installs+1)); echo "install $installs" >> "$trace"; if [[ '${fail}' == first-install && "$installs" == 1 || '${fail}' == second-install && "$installs" == 2 ]]; then return 42; fi; }
systemctl(){ echo "systemctl $*" >> "$trace"; if [[ "$1" == enable && '${fail}' == enable ]]; then return 42; fi; if [[ "$1" == is-active && '${fail}' != none ]]; then return 3; fi; }
pm2(){ echo "pm2 $*" >> "$trace"; }
start_production(){ echo "start $1" >> "$trace"; }
ready(){ echo "ready $1" >> "$trace"; }
ln(){ echo "ln $*" >> "$trace"; }
rm(){ echo "rm $*" >> "$trace"; }
sha256sum(){ return 0; }
${fn('install_order_timer')}
${fn('publish_cleanup')}
trap publish_cleanup EXIT
install_order_timer
rollback=0
`;
    const r = spawnSync('bash', ['-c', setup], { encoding: 'utf8' });
    const lines = readFileSync(trace, 'utf8');
    assert.equal(r.status === 0, fail === 'none', r.stderr);
    if (fail === 'none') assert.ok(!lines.includes('start /old'));
    else {
      assert.match(lines, /start \/old/);
      assert.ok(lines.indexOf('systemctl disable --now boomer-youzan-order-sync.timer') < lines.indexOf('start /old'));
      assert.ok(lines.indexOf('systemctl stop boomer-youzan-order-sync.service') < lines.indexOf('start /old'));
    }
    assert.ok(!lines.includes('boomer-youzan-sync.'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ['candidate', 'public']) test(`order guard ${mode} checks both actions without production credentials`, async () => {
  const code = source.match(/<<'ORDER_GUARD'\n([\s\S]*?)\nORDER_GUARD/)[1].replace(/^import[^\n]*\n/, '');
  const calls = [], logs = [];
  const base = mode === 'candidate' ? 'http://127.0.0.1:3006' : 'https://erp.boomeroff.com';
  await vm.runInNewContext(`(async()=>{${code}})()`, {
    assert, process: { argv: ['node', '-', base, mode], env: { SUPABASE_SERVICE_ROLE_KEY: 'test-secret' } },
    AbortSignal, console: { log: x => logs.push(x) }, fetch: async (url, init) => {
      calls.push({ url, init }); return Response.json({ code: mode === 'candidate' ? 'worker_disabled' : 'unauthorized' }, { status: mode === 'candidate' ? 503 : 401 });
    },
  });
  assert.deepEqual(calls.map(c => JSON.parse(c.init.body).action), ['enqueue', 'run']);
  for (const { init } of calls) {
    assert.equal(init.headers.Authorization, mode === 'candidate' ? 'Bearer test-secret' : undefined);
    assert.equal(init.redirect, 'error');
  }
  assert.ok(!JSON.stringify(logs).includes('test-secret'));
});
