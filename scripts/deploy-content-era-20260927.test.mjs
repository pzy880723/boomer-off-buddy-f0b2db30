import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const path = 'scripts/deploy-content-era-20260927.sh';
const script = existsSync(path) ? readFileSync(path, 'utf8') : '';
test('era release preserves the current deployment as rollback and checks patch first', () => {
  assert.match(script, /old="\$base\/releases\/listing-content-20260927"/);
  assert.match(script, /release="\$base\/releases\/content-era-20260927"/);
  assert.match(script, /readlink -f/);
  assert.ok(script.indexOf('git apply --check') >= 0);
  assert.ok(script.indexOf('git apply --check') < script.indexOf('git apply /tmp/'));
});
test('candidate must have all three workers disabled before publishing', () => {
  assert.match(script, /ERP_PORT=3006/);
  for (const endpoint of ['handheld-release-worker', 'handheld-item-sync-worker', 'listing-image-worker']) {
    assert.ok(script.includes(endpoint));
  }
  assert.match(script, /worker_disabled/);
});
test('rollback is armed until public verification; existing timer remains intact', () => {
  assert.match(script, /trap cleanup EXIT/);
  assert.ok(script.indexOf('https://erp.boomeroff.com') < script.indexOf('rollback=0'));
  assert.match(script, /APP_DIR="\$old" ERP_PORT=3005/);
  assert.doesNotMatch(script, /systemctl disable|npm install|npm ci/);
});
test('deployment shell parses', () => {
  assert.equal(spawnSync('bash', ['-n', path]).status, 0);
});
