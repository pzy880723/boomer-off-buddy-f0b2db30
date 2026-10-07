import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const file = new URL('./deploy-youzan-sale-recovery-20261007.sh', import.meta.url);
test('release script has valid shell syntax', () => {
  assert.equal(spawnSync('bash', ['-n', fileURLToPath(file)]).status, 0);
});
test('candidate cannot enable sale compensation or outgoing channel jobs', () => {
  const code = readFileSync(file, 'utf8');
  assert.match(code, /YOUZAN_SALE_COMPENSATION_ENABLED=false/);
  assert.match(code, /CHANNEL_SYNC_WORKER_ENABLED=false/);
  assert.match(code, /YOUZAN_ORDER_SYNC_WORKER_ENABLED=false/);
});
test('publish verifies candidate and retains a tested rollback to the exact preceding release', () => {
  const code = readFileSync(file, 'utf8');
  assert.match(code, /sale-compensation-v2-20261007/);
  assert.match(code, /trap cleanup EXIT/);
  assert.match(code, /start_live "\$old"/);
  assert.match(code, /sha256sum --check --status \.sale-ready\.sha256/);
  assert.match(code, /verify https:\/\/erp\.boomeroff\.com/);
});
