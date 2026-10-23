import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const mod = await import('./member-onboarding-dispatch.mjs').catch(() => ({}));
const id = 'd49226af-06b9-4cae-b878-81d580db81f0';
test('selects queued and expired tasks only and deduplicates identifiers', () => {
  assert.equal(typeof mod.selectDueJobs, 'function');
  assert.deepEqual(mod.selectDueJobs([
    { shop_id: id, status: 'queued' }, { shop_id: id, status: 'queued' },
    { shop_id: 'invalid;command', status: 'queued' },
    { shop_id: '658c92aa-6cb0-4067-8989-264e44a17eb9', status: 'blocked' },
    { shop_id: 'eecdad4d-6c86-47af-8878-b24cb6f12bd9', status: 'running', lease_until: '2099-01-01' },
    { shop_id: 'da06cdae-5ec1-4749-8dcb-dc972cfd05c9', status: 'running', lease_until: '2026-01-01' },
  ], Date.parse('2026-10-23')), [id, 'da06cdae-5ec1-4749-8dcb-dc972cfd05c9']);
});
test('dispatcher has no asset adapter and runs only explicit claimed candidates', async () => {
  assert.equal(typeof mod.dispatchJobs, 'function');
  const ran = [];
  const result = await mod.dispatchJobs({ list: async () => [{ shop_id: id, status: 'queued' }], run: async value => { ran.push(value); } });
  assert.deepEqual(ran, [id]); assert.deepEqual(result, { attempted: 1, failed: 0 });
});
test('empty queue does not start children and failed children do not hide other tasks', async () => {
  assert.equal(typeof mod.dispatchJobs, 'function');
  assert.deepEqual(await mod.dispatchJobs({ list: async () => [], run: async () => { throw Error('unexpected'); } }), { attempted: 0, failed: 0 });
  assert.deepEqual(await mod.dispatchJobs({ list: async () => [{ shop_id: id, status: 'queued' }], run: async () => { throw Error('worker failed'); } }), { attempted: 1, failed: 1 });
});
test('CLI safety gate executes when invoked through the release symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'member-dispatch-'));
  try {
    const entry = join(dir, 'current.mjs');
    symlinkSync(fileURLToPath(new URL('./member-onboarding-dispatch.mjs', import.meta.url)), entry);
    const result = spawnSync(process.execPath, [entry], { env: { ...process.env, BOOMER_RUNTIME: 'test' }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /member_onboarding_dispatch_failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('transient checks retry only after fifteen minutes and within three total attempts', () => {
  const now = Date.parse('2026-10-23T06:00:00Z');
  const row = { shop_id: id, status: 'blocked', reason: 'worker_unavailable', attempts: 1, retry_after: '2026-10-23T05:59:00Z', checks: { transientRetryEligible: true } };
  assert.deepEqual(mod.selectDueJobs([row], now), [id]);
  for (const patch of [{ attempts: 3 }, { attempts: 0 }, { retry_after: '2026-10-23T06:01:00Z' }, { retry_after: 'invalid' }, { checks: { transientRetryEligible: false } }, { checks: {} }, { reason: 'pos_local_wallet_path' }, { reason: 'member_mapping_incomplete' }]) {
    assert.deepEqual(mod.selectDueJobs([{ ...row, ...patch }], now), []);
  }
});
test('REST selector requests retry metadata with the same bounded transient condition', () => {
  assert.equal(typeof mod.dueJobQuery, 'function');
  const query = mod.dueJobQuery(Date.parse('2026-10-23T06:00:00Z'));
  assert.equal(query.get('select'), 'shop_id,status,lease_until,reason,attempts,retry_after,checks');
  assert.ok(query.get('or').includes('and(status.eq.blocked,reason.eq.worker_unavailable,attempts.gt.0,attempts.lt.3,checks->>transientRetryEligible.eq.true,retry_after.lte.2026-10-23T06:00:00.000Z)'));
  assert.equal(query.get('limit'), '4');
});