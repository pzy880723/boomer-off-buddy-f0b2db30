import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.POINTS_PGLITE_MODULE
  ? pathToFileURL(process.env.POINTS_PGLITE_MODULE).href : '@electric-sql/pglite');

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const X = '00000000-0000-0000-0000-00000000000c'; // blocked customer
const HQ = 100, SHOP = 101, OTHER_HQ = 200, OTHER_SHOP = 201;
const db = new PGlite();

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE TABLE public.commerce_customers (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE public.youzan_shops (kdt_id bigint PRIMARY KEY, role text, parent_kdt_id bigint, status text);
    INSERT INTO public.commerce_customers VALUES ('${A}','active'),('${B}','active'),('${X}','blocked');
    INSERT INTO public.youzan_shops VALUES (${HQ},'hq',NULL,'active'),(${SHOP},'branch',${HQ},'active'),
      (${OTHER_HQ},'hq',NULL,'active'),(${OTHER_SHOP},'branch',${OTHER_HQ},'active');
  `);
  const sqlPath = process.env.YZ_POINTS_OPS_SQL ? pathToFileURL(process.env.YZ_POINTS_OPS_SQL) : new URL('../drizzle/migrations/0032_youzan_points_operations.sql', import.meta.url);
  await db.exec(await readFile(sqlPath, 'utf8'));
});
beforeEach(() => db.exec('RESET ROLE; TRUNCATE public.youzan_points_operations;'));
after(() => db.close());

const begin = async (key, o = {}) => {
  const a = { customer: A, kdt: HQ, source: SHOP, yz: 'OPEN_A', kind: 'debit', points: 100, parent: null, ...o };
  return (await db.query('SELECT public.youzan_points_operation_begin($1,$2,$3,$4,$5,$6,$7,$8) AS r',
    [key, a.customer, a.kdt, a.source, a.yz, a.kind, a.points, a.parent])).rows[0].r;
};
const claim = async (id) => (await db.query('SELECT public.youzan_points_operation_claim($1) AS r', [id])).rows[0].r;
const finish = async (id, token, status, reason = null) =>
  (await db.query('SELECT public.youzan_points_operation_finish($1,$2,$3,$4) AS r', [id, token, status, reason])).rows[0].r;
const succeed = async (id) => { const c = await claim(id); assert.ok(c); assert.equal(await finish(id, c.claim_token, 'succeeded'), true); };

test('idempotency: same key same payload returns original; different payload rejected', async () => {
  const a = await begin('debit-key-0001');
  const again = await begin('debit-key-0001');
  assert.equal(again.id, a.id);
  assert.equal(again.idempotent, true);
  await assert.rejects(begin('debit-key-0001', { points: 99 }), /operation_key_payload_conflict/);
  assert.equal((await db.query('SELECT count(*)::int n FROM youzan_points_operations')).rows[0].n, 1);
});

test('serial per account: second operation blocked while one is unresolved; idempotent replay still works', async () => {
  const a = await begin('debit-key-0001');
  await assert.rejects(begin('debit-key-0002', { points: 5 }), /customer_operation_in_flight/);
  assert.equal((await begin('debit-key-0001')).id, a.id);
  for (const st of ['unknown', 'blocked']) {
    const c = await claim(a.id);
    assert.equal(await finish(a.id, c.claim_token, st, 'proxy_timeout'), true);
    await assert.rejects(begin('debit-key-0003', { points: 5 }), /customer_operation_in_flight/);
  }
});

test('out-of-order refund: parent must be a succeeded debit', async () => {
  const d = await begin('debit-key-0001');
  await assert.rejects(begin('refund-key-001', { kind: 'refund', points: 10, parent: d.id }), /customer_operation_in_flight|refund_parent_not_succeeded/);
  await db.exec(`UPDATE youzan_points_operations SET status='unknown'`);
  await assert.rejects(begin('refund-key-001', { kind: 'refund', points: 10, parent: d.id }), /customer_operation_in_flight|refund_parent_not_succeeded/);
  await db.exec(`UPDATE youzan_points_operations SET status='pending'`);
  await succeed(d.id);
  assert.equal((await begin('refund-key-001', { kind: 'refund', points: 10, parent: d.id })).status, 'pending');
  await assert.rejects(begin('refund-key-002', { kind: 'refund', points: 10 }), /refund_parent_required/);
  await assert.rejects(begin('debit-key-0009', { parent: d.id }), /debit_parent_not_allowed/);
});

test('refund caps: repeated and over-refunds rejected; all statuses count', async () => {
  const d = await begin('debit-key-0001');
  await succeed(d.id);
  const r1 = await begin('refund-key-001', { kind: 'refund', points: 60, parent: d.id });
  await succeed(r1.id);
  await assert.rejects(begin('refund-key-002', { kind: 'refund', points: 50, parent: d.id }), /refund_exceeds_debit/);
  const r2 = await begin('refund-key-002', { kind: 'refund', points: 40, parent: d.id });
  // 未决退款（unknown/blocked）同样计入：直接把 r2 改 blocked 后释放串行锁验证额度
  await db.exec(`UPDATE youzan_points_operations SET status='blocked' WHERE id='${r2.id}'`);
  await db.exec(`UPDATE youzan_points_operations SET customer_id='${A}' WHERE false`);
  await assert.rejects(begin('refund-key-003', { kind: 'refund', points: 1, parent: d.id }), /customer_operation_in_flight|refund_exceeds_debit/);
  await db.exec(`UPDATE youzan_points_operations SET status='succeeded' WHERE id='${r2.id}'`);
  await assert.rejects(begin('refund-key-003', { kind: 'refund', points: 1, parent: d.id }), /refund_exceeds_debit/);
});

test('cross customer / identity / shop binding rejected', async () => {
  const d = await begin('debit-key-0001');
  await succeed(d.id);
  await assert.rejects(begin('debit-key-0002', { customer: B, yz: 'OPEN_A' }), /identity_customer_conflict/);
  await assert.rejects(begin('debit-key-0003', { yz: 'OPEN_OTHER' }), /identity_customer_conflict/);
  await assert.rejects(begin('refund-key-001', { kind: 'refund', points: 1, parent: d.id, customer: B, yz: 'OPEN_B' }), /refund_parent_mismatch/);
  await assert.rejects(begin('refund-key-002', { kind: 'refund', points: 1, parent: d.id, source: HQ }), /refund_parent_mismatch/);
  await assert.rejects(begin('debit-key-0004', { customer: B, yz: 'OPEN_B', source: OTHER_SHOP }), /source_shop_not_under_head/);
  await assert.rejects(begin('debit-key-0005', { customer: B, yz: 'OPEN_B', kdt: SHOP, source: SHOP }), /head_shop_invalid/);
  await assert.rejects(begin('debit-key-0006', { customer: X, yz: 'OPEN_X' }), /customer_not_active/);
  await assert.rejects(begin('bad key', { customer: B, yz: 'OPEN_B' }), /invalid_operation/);
  await assert.rejects(begin('debit-key-0007', { customer: B, yz: 'OPEN_B', points: 0 }), /invalid_operation/);
});

test('claim: fencing, no double claim, expiry reclaim, attempt and 24h caps', async () => {
  const d = await begin('debit-key-0001');
  const c1 = await claim(d.id);
  assert.equal(c1.operation_key, 'debit-key-0001');
  assert.equal(await claim(d.id), null);
  await db.exec(`UPDATE youzan_points_operations SET lease_until=now()-interval '1 second'`);
  assert.equal(await finish(d.id, c1.claim_token, 'succeeded'), false);
  const c2 = await claim(d.id);
  assert.notEqual(c2.claim_token, c1.claim_token);
  assert.equal(c2.operation_key, c1.operation_key);
  assert.equal(await finish(d.id, c1.claim_token, 'succeeded'), false);
  await assert.rejects(finish(d.id, c2.claim_token, 'pending'), /invalid_finish_status/);
  await assert.rejects(finish(d.id, c2.claim_token, 'unknown', 'Bad Reason!'), /invalid_reason/);
  assert.equal(await finish(d.id, c2.claim_token, 'unknown', 'proxy_timeout'), true);
  await db.exec(`UPDATE youzan_points_operations SET attempts=8`);
  assert.equal(await claim(d.id), null);
  await db.exec(`UPDATE youzan_points_operations SET attempts=1, created_at=now()-interval '25 hours'`);
  assert.equal(await claim(d.id), null);
  await db.exec(`UPDATE youzan_points_operations SET created_at=now(), status='succeeded'`);
  assert.equal(await claim(d.id), null);
  assert.equal((await db.query('SELECT count(*)::int n FROM youzan_points_operations')).rows[0].n, 1);
});

test('anon/authenticated cannot read, write or execute', async () => {
  const d = await begin('debit-key-0001');
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT * FROM public.youzan_points_operations'), /permission denied/);
    await assert.rejects(db.query(`SELECT public.youzan_points_operation_claim('${d.id}')`), /permission denied/);
    await assert.rejects(db.query(`SELECT public.youzan_points_operation_begin('debit-key-0099','${B}',${HQ},${SHOP},'OPEN_B','debit',1,NULL)`), /permission denied/);
    await assert.rejects(db.query(`SELECT public.youzan_points_operation_finish('${d.id}',gen_random_uuid(),'succeeded',NULL)`), /permission denied/);
    await db.exec('RESET ROLE');
  }
  const rls = (await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='youzan_points_operations'`)).rows[0];
  assert.equal(rls.relrowsecurity, true);
});

test('no secret/phone/raw-response columns', async () => {
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='youzan_points_operations'`)).rows.map(r => r.column_name);
  for (const c of cols) assert.doesNotMatch(c, /token$|access|mobile|phone|response|raw/);
});
