import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.POINTS_PGLITE_MODULE
  ? pathToFileURL(process.env.POINTS_PGLITE_MODULE).href : '@electric-sql/pglite');

const db = new PGlite();
before(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('test.user_id', true),'')::uuid
    $$;
    CREATE FUNCTION public.has_role(uuid,text) RETURNS boolean LANGUAGE sql AS $$
      SELECT coalesce($1='00000000-0000-0000-0000-000000000001'::uuid AND $2='hq_operator',false)
    $$;
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    CREATE TABLE public.youzan_shops (kdt_id bigint PRIMARY KEY, status text);
    INSERT INTO public.youzan_shops VALUES (1,'active');
  `);
  for (const name of ['0024_youzan_member_asset_inbox', '0025_youzan_asset_inbox_fencing',
    '0026_youzan_asset_inbox_points_envelope', '0027_youzan_asset_inbox_coupon_events',
    '0028_youzan_member_asset_observations', '0029_youzan_asset_tables_tighten_grants',
    '0030_youzan_points_observation_version_guard']) {
    await db.exec(await readFile(new URL(`../drizzle/migrations/${name}.sql`, import.meta.url), 'utf8'));
  }
});
beforeEach(() => db.exec('RESET ROLE; TRUNCATE public.youzan_member_asset_inbox,public.youzan_member_asset_observations;'));
after(() => db.close());
async function ingest(event = 'test-event', hash = 'hash-1') {
  return (await db.query(`SELECT public.youzan_asset_inbox_ingest(1,$1,'POINTS',$2,'{"unique_id":"test"}') AS result`, [event, hash])).rows[0].result;
}
async function claim() {
  return (await db.query('SELECT * FROM public.youzan_asset_inbox_claim(1)')).rows[0];
}
async function finish(row, status = 'blocked') {
  return (await db.query(`SELECT public.youzan_asset_inbox_finish($1,$2,$3,'test',now()) AS result`, [row.id, row.claim_token, status])).rows[0].result;
}
test('SQL duplicate ingest keeps one row; conflicting payload cannot replace original', async () => {
  const first = await ingest();
  assert.equal(first.result, 'accepted');
  assert.deepEqual(await ingest(), { ...first, result: 'duplicate' });
  assert.deepEqual(await ingest('test-event', 'different'), { ...first, result: 'conflict' });
  const rows = (await db.query('SELECT payload_hash,conflict_count FROM youzan_member_asset_inbox')).rows;
  assert.deepEqual(rows, [{ payload_hash: 'hash-1', conflict_count: 1 }]);
  assert.equal((await db.query('SELECT status FROM youzan_member_asset_inbox')).rows[0].status, 'blocked');
});
test('SQL expired lease and stale worker cannot overwrite new claim', async () => {
  await ingest();
  const old = await claim();
  await db.query("UPDATE youzan_member_asset_inbox SET lease_until=now()-interval '1 second' WHERE id=$1", [old.id]);
  assert.equal(await finish(old), false);
  const current = await claim();
  assert.notEqual(old.claim_token, current.claim_token);
  assert.equal(await finish(current), true);
  assert.equal(await finish(old, 'retry'), false);
  assert.equal((await db.query('SELECT status FROM youzan_member_asset_inbox')).rows[0].status, 'blocked');
});
test('SQL requeue invalidates an active claim', async () => {
  await ingest();
  const old = await claim();
  await db.query('SELECT public.youzan_asset_inbox_requeue($1)', [old.id]);
  assert.equal(await finish(old), false);
  const current = await claim();
  assert.notEqual(old.claim_token, current.claim_token);
  assert.equal(await finish(current), true);
});
test('SQL cannot acknowledge an asset as successfully applied', async () => {
  await ingest();
  const row = await claim();
  await assert.rejects(finish(row, 'success'), /invalid inbox finish status/);
  assert.equal((await db.query('SELECT status FROM youzan_member_asset_inbox')).rows[0].status, 'processing');
});
test('SQL mutation RPCs are service-only and unsafe finish overload is gone', async () => {
  const functions = (await db.query(`SELECT oid::int,proname,pronargs FROM pg_proc WHERE proname LIKE 'youzan_asset_inbox_%'`)).rows;
  assert.equal(functions.length, 4);
  assert.equal(functions.find(f => f.proname === 'youzan_asset_inbox_finish').pronargs, 5);
  for (const fn of functions) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const result = (await db.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS allowed", [role, fn.oid])).rows[0];
      assert.equal(result.allowed, role === 'service_role', `${role}:${fn.proname}`);
    }
  }
  await db.exec('SET ROLE authenticated');
  await assert.rejects(ingest(), /permission denied/);
  await assert.rejects(db.exec('DELETE FROM youzan_member_asset_inbox'), /permission denied/);
  await db.exec('RESET ROLE');
});
test('SQL RLS hides inbox from shop users and allows headquarters read-only', async () => {
  await ingest();
  await db.exec("SET ROLE authenticated; SET test.user_id='00000000-0000-0000-0000-000000000002';");
  assert.equal((await db.query('SELECT * FROM youzan_member_asset_inbox')).rows.length, 0);
  await db.exec("SET test.user_id='00000000-0000-0000-0000-000000000001';");
  assert.equal((await db.query('SELECT * FROM youzan_member_asset_inbox')).rows.length, 1);
  await db.exec('RESET ROLE; SET ROLE anon;');
  await assert.rejects(db.query('SELECT * FROM youzan_member_asset_inbox'), /permission denied/);
  await db.exec('RESET ROLE');
});

async function observe(row, expected = 0, time = Date.now(), point = 10, version = '9007199254740999') {
  return (await db.query(`SELECT public.youzan_asset_observation_record($1,$2,1,'test-member','points','',
    '00000000-0000-0000-0000-000000000003',$3,$4,$5,'youzan_fixed_proxy_readonly') AS result`,
    [row.id, row.claim_token, JSON.stringify({ point, points_account_version: version }), new Date(time).toISOString(), expected])).rows[0].result;
}
test('SQL observations honor lease, version and newer observation timestamps', async () => {
  const time = Date.now() - 10000;
  await ingest('first');
  const first = await claim();
  assert.equal((await observe({ ...first, claim_token: '00000000-0000-0000-0000-000000000000' })).result, 'stale_lease');
  assert.equal((await observe(first, 1)).result, 'stale_version');
  assert.equal((await observe(first, 0, time)).result, 'recorded');
  assert.equal((await observe(first, 1)).result, 'stale_lease');
  await ingest('second');
  const second = await claim();
  assert.equal((await observe(second, 0)).result, 'stale_version');
  assert.equal((await observe(second, 1, time + 1000, 11, '9007199254740998')).result, 'older_observation');
  const snapshot = (await db.query('SELECT observed,row_version FROM youzan_member_asset_observations')).rows[0];
  assert.equal(snapshot.row_version, 1);
  assert.equal(snapshot.observed.points_account_version, '9007199254740999');
});
test('SQL same-version conflict is blocked, same-value is idempotent, newer account version wins', async () => {
  const time = Date.now() - 10000;
  await ingest('first');
  assert.equal((await observe(await claim(), 0, time)).result, 'recorded');
  await ingest('conflict');
  assert.equal((await observe(await claim(), 1, time + 1000, 20)).result, 'version_conflict');
  await ingest('duplicate');
  assert.equal((await observe(await claim(), 1, time + 2000)).result, 'same_version_observed');
  await ingest('newer');
  assert.equal((await observe(await claim(), 1, time - 1000, 8, '9007199254741000')).result, 'recorded');
  const snapshot = (await db.query('SELECT observed,row_version,observed_at FROM youzan_member_asset_observations')).rows[0];
  assert.deepEqual(snapshot.observed, { point: 8, points_account_version: '9007199254741000' });
  assert.equal(snapshot.row_version, 2);
  assert.equal(new Date(snapshot.observed_at).getTime(), time);
});
test('SQL observation RPCs and tables have explicit service-only write permissions', async () => {
  const functions = (await db.query("SELECT oid::int FROM pg_proc WHERE proname LIKE 'youzan_asset_observation_%'")).rows;
  assert.equal(functions.length, 2);
  for (const fn of functions) for (const role of ['anon', 'authenticated', 'service_role']) {
    const result = (await db.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') AS allowed", [role, fn.oid])).rows[0];
    assert.equal(result.allowed, role === 'service_role');
  }
  for (const table of ['youzan_member_asset_inbox', 'youzan_member_asset_observations']) {
    for (const role of ['anon', 'authenticated']) for (const action of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, table, action])).rows[0].allowed, false);
    }
  }
});
