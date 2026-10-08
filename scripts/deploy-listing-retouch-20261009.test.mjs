import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const file = new URL('./deploy-listing-retouch-20261009.sh', import.meta.url);
test('retouch release script has valid shell syntax', () => {
  assert.equal(spawnSync('bash', ['-n', fileURLToPath(file)]).status, 0);
});
test('candidate disables every background worker and does not install an inference runtime', () => {
  const code = readFileSync(file, 'utf8');
  for (const flag of ['HANDHELD_RELEASE_WORKER', 'HANDHELD_ITEM_SYNC_WORKER', 'HANDHELD_LISTING_IMAGE_WORKER',
    'YOUZAN_STOCK_WORKER', 'YOUZAN_IMAGE_REFRESH_WORKER', 'YOUZAN_ORDER_SYNC_WORKER', 'YOUZAN_SALE_COMPENSATION', 'CHANNEL_SYNC_WORKER']) {
    assert.ok(code.includes(`${flag}_ENABLED=false`), flag);
  }
  assert.doesNotMatch(code, /npm install|onnx|birefnet|migration|repair-padded/);
});
test('release freezes environment and compiled source, preserves rollback and verifies public manifest', () => {
  const code = readFileSync(file, 'utf8');
  assert.match(code, /sha256sum \/etc\/boomer-erp\/workers.env \.env/);
  assert.match(code, /sha256sum --check --status \.retouch-ready\.sha256/);
  assert.match(code, /trap cleanup EXIT/);
  assert.match(code, /start_live "\$old"/);
  assert.match(code, /verify https:\/\/erp\.boomeroff\.com/);
  assert.match(code, /verify_manifest http:\/\/127\.0\.0\.1:3006/);
  assert.match(code, /verify_manifest https:\/\/erp\.boomeroff\.com/);
  assert.match(code, /sudo -n ln -sfn "\$release" "\$base\/current"/);
  assert.ok(code.indexOf('fs.writeFileSync("public/retouch-release.json"') < code.indexOf('npm run build:tencent'));
  assert.ok(code.indexOf('verify_manifest http://127.0.0.1:3006', code.indexOf('cd "$release"\nsha256sum')) < code.indexOf('trap cleanup EXIT'));
});
