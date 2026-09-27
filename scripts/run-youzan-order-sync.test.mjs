import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

const file = new URL('./run-youzan-order-sync.mjs', import.meta.url);
const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
const secret = 'test-only-secret-do-not-log';
const success = { claimed: true, applied: true, status: 'pending', upserted: 2 };
const idle = { claimed: false, reason: 'idle' };
async function runner({ env = { SUPABASE_SERVICE_ROLE_KEY: secret }, result = success, http = 200, payload, enqueue, error, elapsedPerCall = 0, invalidJSON = false } = {}) {
  const calls = [], logs = [], timeouts = [];
  let elapsed = 0;
  const process = { env, exitCode: 0 };
  await vm.runInNewContext(`(async()=>{${source}\n})()`, {
    process, Date: { now: () => elapsed }, console: { log: x => logs.push(x), error: x => logs.push(x) },
    AbortSignal: { timeout: ms => { timeouts.push(ms); return AbortSignal.timeout(ms); } },
    fetch: async (url, init) => {
      calls.push({ url, init });
      elapsed += elapsedPerCall;
      if (error) throw error;
      if (invalidJSON) return new Response(secret);
      const action = JSON.parse(init.body).action;
      return action === 'enqueue'
        ? Response.json(enqueue ?? { ok: true, action, data: { shops: 3, windows: 3 } })
        : Response.json(payload ?? { ok: true, action, data: { results: [result] } }, { status: http });
    },
  });
  assert.ok(!JSON.stringify(logs).includes(secret));
  return { calls, logs, timeouts, exit: process.exitCode };
}
test('runner enqueues days1 then at most 3 one-slice, two-page ORDER-only calls', async () => {
  const r = await runner(); assert.equal(r.exit, 0); assert.equal(r.calls.length, 4);
  assert.deepEqual(JSON.parse(r.calls[0].init.body), { action: 'enqueue', days: 1 });
  for (const c of r.calls.slice(1)) assert.deepEqual(JSON.parse(c.init.body), { action: 'run', slices: 1, max_pages: 2 });
  for (const c of r.calls) {
    assert.equal(c.url, 'http://127.0.0.1:3005/api/public/hooks/youzan-order-sync');
    assert.equal(c.init.headers.Authorization, `Bearer ${secret}`); assert.equal(c.init.redirect, 'error');
    assert.ok(c.init.signal instanceof AbortSignal);
  }
  assert.ok(r.timeouts.every(t => t > 0 && t <= 115000));
});
test('idle stops further claims', async () => { const r = await runner({ result: idle }); assert.equal(r.exit, 0); assert.equal(r.calls.length, 2); });
for (const env of [{}, { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: '3006' }, { SUPABASE_SERVICE_ROLE_KEY: secret, ERP_PORT: '443' }])
  test(`runner refuses unconfigured/nonproduction destination ${env.ERP_PORT}`, async () => {
    const r = await runner({ env }); assert.equal(r.exit, 1); assert.equal(r.calls.length, 0);
  });
for (const result of [
  { ...success, applied: false }, { ...success, status: 'error' }, { ...success, status: 'failed' },
  { ...success, status: 'lease_lost' }, { ...success, error: secret }, { ...success, applied: 'true' },
  { ...success, status: 'unexpected' }, { claimed: false, error: secret }, {},
  { ...idle, status: 'error' }, { ...idle, applied: false },
]) test(`runner rejects unsuccessful/malformed slice ${JSON.stringify(result).replace(secret, 'redacted')}`, async () => {
  const r = await runner({ result }); assert.equal(r.exit, 1); assert.equal(r.calls.length, 2);
});
for (const http of [207, 401, 500]) test(`runner rejects HTTP ${http} despite ok:true`, async () => {
  assert.equal((await runner({ http })).exit, 1);
});
test('runner refuses malformed enqueue before running', async () => {
  const r = await runner({ enqueue: { ok: true, data: { error: secret } } }); assert.equal(r.exit, 1); assert.equal(r.calls.length, 1);
});
test('runner sanitizes credential-bearing network errors', async () => { assert.equal((await runner({ error: Error(secret) })).exit, 1); });
test('runner does not accept empty results or stringify a server error', async () => {
  assert.equal((await runner({ payload: { ok: true, action: 'run', error: secret, data: { results: [] } } })).exit, 1);
});
test('runner stops starting calls after total budget; timeout is not an automatic retry', async () => {
  const r = await runner({ elapsedPerCall: 120000 }); assert.equal(r.exit, 1); assert.equal(r.calls.length, 2);
});
test('runner never logs malformed JSON containing credentials', async () => { assert.equal((await runner({ invalidJSON: true })).exit, 1); });

const hookSource = readFileSync(new URL('../src/routes/api/public/hooks/youzan-order-sync.ts', import.meta.url), 'utf8');
async function hook({ env = {}, result = success, action = 'run', token = secret, throws = false, slices = 1 } = {}) {
  const calls = [];
  const code = hookSource.slice(hookSource.indexOf('type Body')).replace('export const Route', 'const Route');
  const route = vm.runInNewContext(`${stripTypeScriptTypes(code)}\nRoute`, {
    createFileRoute: () => r => r, Response, crypto, process: { env: { SUPABASE_SERVICE_ROLE_KEY: secret, ...env } },
    enqueueOrderSyncWindows: async () => { calls.push('enqueue'); return { shops: 1, windows: 1 }; },
    runOrderSyncSliceOnce: async () => { calls.push('run'); if (throws) throw Error(secret); return result; },
    orderSyncProgress: async () => ({}),
  });
  const response = await route.server.handlers.POST({ request: new Request('http://localhost/api/public/hooks/youzan-order-sync', {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ action, slices }),
  }) });
  const body = await response.json(); assert.ok(!JSON.stringify(body).includes(secret));
  return { status: response.status, body, calls };
}
for (const result of [{ ...success, applied: false }, { ...success, status: 'error' }, { ...success, status: 'failed' }, { ...success, status: 'lease_lost' }])
  test(`hook reports failure and stops run loop (${result.status}/${result.applied})`, async () => {
    const r = await hook({ result, slices: 3 }); assert.equal(r.status, 207); assert.equal(r.body.ok, false); assert.equal(r.calls.length, 1);
  });
for (const action of ['enqueue', 'run']) test(`candidate cannot ${action}`, async () => {
  const r = await hook({ action, env: { ERP_PORT: '3006' } }); assert.equal(r.status, 503); assert.deepEqual(r.calls, []);
});
test('auth is checked before disabled guard', async () => { assert.equal((await hook({ token: 'bad', env: { ERP_PORT: '3006' } })).status, 401); });
test('explicit disabled flag blocks worker', async () => { assert.equal((await hook({ env: { YOUZAN_ORDER_SYNC_WORKER_ENABLED: 'false' } })).status, 503); });
test('progress remains read only on candidate', async () => { const r = await hook({ action: 'progress', env: { ERP_PORT: '3006' } }); assert.equal(r.status, 200); assert.deepEqual(r.calls, []); });
test('hook exception does not expose credentials', async () => { assert.equal((await hook({ throws: true })).status, 500); });
test('unset worker flag preserves existing enabled behavior', async () => { assert.equal((await hook()).status, 200); });
test('idle carrying an error status is not successful', async () => {
  const r = await hook({ result: { ...idle, status: 'error' } }); assert.equal(r.status, 207); assert.equal(r.body.ok, false);
});

const db = new PGlite();
const migrationDir = new URL('../supabase/migrations/', import.meta.url);
const migration = readdirSync(migrationDir).find(n => n.endsWith('_youzan_order_fast_schedule.sql'));
const oldSQL = readFileSync(new URL('20260907191142_7d0f83df-f771-49f6-a846-10100a7b4151.sql', migrationDir), 'utf8');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE youzan_shops(id uuid PRIMARY KEY);
    ${readFileSync(new URL('20260907171328_5868ff69-1e58-4b13-b748-75fb350258f3.sql', migrationDir), 'utf8').split('GRANT SELECT')[0]}
    ALTER TABLE youzan_order_sync_cursors DROP CONSTRAINT youzan_order_sync_cursors_status_chk,
      ADD COLUMN scan_end timestamptz, ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN last_completed_scan_end timestamptz, ADD COLUMN last_completed_at timestamptz;`);
  for (const name of ['claim', 'advance']) {
    const fn = oldSQL.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.youzan_${name}_order_sync_cursor\\([\\s\\S]*?GRANT EXECUTE[^;]+;`));
    assert.ok(fn); await db.exec(fn[0]);
  }
  assert.ok(migration); await db.exec(readFileSync(new URL(migration, migrationDir), 'utf8'));
});
beforeEach(async () => { await db.exec('RESET ROLE; TRUNCATE youzan_order_sync_cursors,youzan_shops CASCADE;'); await db.query('INSERT INTO youzan_shops VALUES($1)', [id(1)]); });
after(async () => { await db.close(); });
async function add(n, offset = 0, delay = '-1 minute') {
  await db.query('INSERT INTO youzan_shops VALUES($1) ON CONFLICT DO NOTHING', [id(n)]);
  await db.query(`INSERT INTO youzan_order_sync_cursors(id,shop_id,window_start,window_end,next_run_at)
    VALUES($1,$2,clock_timestamp()+make_interval(days=>$3)-interval '1 hour',clock_timestamp()+make_interval(days=>$3)+interval '1 hour',clock_timestamp()+$4::interval)`, [id(n), id(n), offset, delay]);
}
const claim = (owner = 'worker') => db.query('SELECT * FROM youzan_claim_order_sync_cursor($1,120)', [owner]).then(r => r.rows[0]);
const row = n => db.query('SELECT * FROM youzan_order_sync_cursors WHERE id=$1', [id(n)]).then(r => r.rows[0]);
const advance = (n, status = 'done', owner = 'worker') => db.query("SELECT youzan_advance_order_sync_cursor($1,$2,$3,5,'v',2,0,NULL) AS applied", [id(n), owner, status]).then(r => r.rows[0].applied);
test('SQL current-day incomplete window wins over older next_run backlog', async () => {
  await add(2, -3, '-3 days'); await add(3); assert.equal((await claim()).id, id(3));
});
test('SQL respects due time, active lease and exhausted errors', async () => {
  await add(2, 0, '1 hour'); await add(3); await add(4); await add(5, -3);
  await db.exec(`UPDATE youzan_order_sync_cursors SET status='running',lease_owner='other',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id='${id(3)}'; UPDATE youzan_order_sync_cursors SET status='error',attempts=8 WHERE id='${id(4)}'`);
  assert.equal((await claim()).id, id(5));
});
test('SQL open scan waits one minute, clears scan snapshot but retains completion watermark', async () => {
  await add(2); const c = await claim(); assert.ok(await advance(2)); const r = await row(2);
  assert.equal(r.status, 'pending'); assert.equal(r.next_page, 1); assert.equal(r.scan_end, null);
  assert.equal(+r.last_completed_scan_end, +c.scan_end); assert.equal(r.method_label, null);
  const seconds = (await db.query('SELECT extract(epoch FROM next_run_at-clock_timestamp())::float AS n FROM youzan_order_sync_cursors')).rows[0].n;
  assert.ok(seconds > 55 && seconds <= 60, `backoff=${seconds}`); assert.equal(await claim(), undefined);
});
test('SQL continuation keeps scan_end and page; live owner cannot be stolen', async () => {
  await add(2); const c = await claim(); assert.equal(await claim('other'), undefined);
  assert.ok(await advance(2, 'pending')); const next = await claim('next');
  assert.equal(next.next_page, 5); assert.equal(+next.scan_end, +c.scan_end); assert.equal(next.attempts, 0);
  assert.equal(await advance(2, 'done', 'worker'), false);
});
test('SQL expired owner cannot advance, new owner preserves scan_end', async () => {
  await add(2); const c = await claim(); await db.exec("UPDATE youzan_order_sync_cursors SET lease_expires_at=clock_timestamp()-interval '1 second'");
  assert.equal(await advance(2), false); const next = await claim('next'); assert.equal(+next.scan_end, +c.scan_end);
  assert.equal(await advance(2), false);
});
test('SQL error backoff stays one minute and does not clear snapshot', async () => {
  await add(2); const c = await claim(); assert.ok(await advance(2, 'error')); const r = await row(2);
  assert.equal(r.status, 'error'); assert.equal(+r.scan_end, +c.scan_end); assert.equal(await claim(), undefined);
  assert.ok(+r.next_run_at - Date.now() > 55000);
});
test('SQL closed scan remains done and cannot be claimed', async () => {
  await add(2, -3); const c = await claim(); assert.equal(+c.scan_end, +c.window_end);
  assert.ok(await advance(2)); assert.equal((await row(2)).status, 'done'); assert.equal(await claim(), undefined);
});
test('SQL stale owner and public roles cannot change queue', async () => {
  await add(2); await claim(); assert.equal(await advance(2, 'done', 'wrong'), false);
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`); await assert.rejects(claim(), /permission denied/); await assert.rejects(advance(2), /permission denied/); await db.exec('RESET ROLE');
  }
});
test('SQL timezone-independent priority includes windows straddling Shanghai midnight', async () => {
  await add(2, -3, '-3 days'); await add(3);
  await db.exec(`SET TIME ZONE 'America/Los_Angeles';
    UPDATE youzan_order_sync_cursors SET
      window_start=(date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')-interval '6 hours',
      window_end=(date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')+interval '6 hours'
    WHERE id='${id(3)}'`);
  try { assert.equal((await claim()).id, id(3)); } finally { await db.exec("SET TIME ZONE 'UTC'"); }
});
test('SQL fully covered reopened window gets no today priority', async () => {
  await add(2, -3, '-3 days'); await add(3);
  await db.exec(`UPDATE youzan_order_sync_cursors SET last_completed_scan_end=window_end WHERE id='${id(3)}'`);
  assert.equal((await claim()).id, id(2));
});
test('SQL current-day shops remain fair across page continuations', async () => {
  await add(2, 0, '-2 minutes'); await add(3);
  assert.equal((await claim()).id, id(2)); await advance(2, 'pending');
  assert.equal((await claim('other')).id, id(3));
});
test('SQL retains retry attempts and service-role permissions', async () => {
  await add(2); await db.exec('UPDATE youzan_order_sync_cursors SET attempts=3; SET ROLE service_role');
  const c = await claim(); assert.equal(c.attempts, 3); assert.ok(await advance(2));
  await db.exec('RESET ROLE');
});
test('migration only changes two scheduling functions, not order/sale or cursor data', () => {
  const sql = readFileSync(new URL(migration, migrationDir), 'utf8');
  assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /commit_sale|commit_order_sync_batch|INSERT INTO|DELETE FROM|ALTER TABLE/i);
  const fn = text => text.slice(text.indexOf('CREATE OR REPLACE FUNCTION public.youzan_advance_order_sync_cursor'));
  assert.equal(fn(sql).trim(), fn(oldSQL).replace("WHEN open_scan THEN clock_timestamp()+interval '30 minutes'", "WHEN open_scan THEN clock_timestamp()+interval '1 minute'").trim());
});
test('new timer is order-only every minute; old 30-minute product timer is unchanged', () => {
  const service = readFileSync(new URL('../infra/tencent/boomer-youzan-order-sync.service', import.meta.url), 'utf8');
  const timer = readFileSync(new URL('../infra/tencent/boomer-youzan-order-sync.timer', import.meta.url), 'utf8');
  assert.match(service, /Type=oneshot/); assert.match(service, /run-youzan-order-sync\.mjs/);
  assert.match(timer, /OnUnitInactiveSec=60s/);
  assert.match(readFileSync(new URL('../infra/tencent/boomer-youzan-sync.timer', import.meta.url), 'utf8'), /OnUnitInactiveSec=30min/);
});
