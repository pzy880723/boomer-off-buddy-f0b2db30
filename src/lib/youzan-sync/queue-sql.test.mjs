import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Disposable, in-memory PostgreSQL only. Never read project credentials.
const runtime = process.env.QUEUE_PGLITE_MODULE;
if (!runtime) throw Error('Set QUEUE_PGLITE_MODULE to a locally installed @electric-sql/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(runtime).href);
const db = new PGlite();
const migration = readFileSync(new URL('../../../supabase/migrations/20260907180726_youzan_queue_hardening.sql', import.meta.url), 'utf8');
const shop = '00000000-0000-0000-0000-000000000001';
const cursor = '00000000-0000-0000-0000-000000000002';
before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE youzan_shops(id uuid PRIMARY KEY, kdt_id bigint);
    INSERT INTO youzan_shops VALUES ('${shop}', 7);
    CREATE FUNCTION tg_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
    CREATE FUNCTION has_role(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
  `);
  const initial = readFileSync(new URL('../../../supabase/migrations/20260907171328_5868ff69-1e58-4b13-b748-75fb350258f3.sql', import.meta.url), 'utf8');
  await db.exec(initial);
  const previous = readFileSync(new URL('../../../supabase/migrations/20260907174126_17d01aa9-c7ae-4f38-b4b7-e77a3f09677a.sql', import.meta.url), 'utf8').split('-- 4)')[0];
  await db.exec(previous);
  const orders = readFileSync(new URL('../../../supabase/migrations/20260521232657_6b4185e8-b362-415d-9310-5059b740a9e5.sql', import.meta.url), 'utf8').split('-- 有赞商品')[0];
  await db.exec(orders);
  await db.exec(readFileSync(new URL('../../../supabase/migrations/20260523052635_3b1abe44-8248-44fc-b9ae-72a9236ece2e.sql', import.meta.url), 'utf8'));
  await db.exec(migration);
});
after(() => db.close());
async function reset() {
  await db.exec('DELETE FROM youzan_orders; DELETE FROM youzan_order_sync_cursors;');
  await db.query(`INSERT INTO youzan_order_sync_cursors(id,shop_id,window_start,window_end) VALUES ($1,$2,now()-interval '1 day',now()+interval '1 day')`, [cursor,shop]);
}
test('actual legacy CHECK allows terminal failed after correction', async () => {
  await reset();
  await db.exec(`UPDATE youzan_order_sync_cursors SET status='failed',attempts=8;`);
  assert.equal((await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)")).rows.length, 0);
});
test('open window fixes scan_end, pauses, and restarts from first page', async () => {
  await reset();
  const claim = (await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)")).rows[0];
  assert.ok(claim.scan_end);
  assert.ok(new Date(claim.scan_end) < new Date(claim.window_end));
  await db.query("SELECT youzan_advance_order_sync_cursor($1,'a','done',1,'v',0,0,NULL)",[cursor]);
  const saved = (await db.query('SELECT * FROM youzan_order_sync_cursors')).rows[0];
  assert.equal(saved.status, 'pending');
  assert.equal(saved.next_page, 1);
  assert.equal(saved.scan_end, null);
  assert.equal((await db.query("SELECT * FROM youzan_claim_order_sync_cursor('b',120)")).rows.length, 0);
});
test('enqueue rearms completed lookback window without resetting in-flight pagination', async () => {
  await reset();
  await db.exec("UPDATE youzan_order_sync_cursors SET status='done',next_page=5,last_progress_at=now()-interval '1 hour'");
  const row = (await db.query('SELECT shop_id,window_start,window_end FROM youzan_order_sync_cursors')).rows[0];
  await db.query('SELECT youzan_enqueue_order_sync_windows($1::jsonb)', [JSON.stringify([row])]);
  assert.equal((await db.query('SELECT status,next_page FROM youzan_order_sync_cursors')).rows[0].next_page, 1);
  await db.exec("UPDATE youzan_order_sync_cursors SET status='pending',next_page=5");
  await db.query('SELECT youzan_enqueue_order_sync_windows($1::jsonb)', [JSON.stringify([row])]);
  assert.equal((await db.query('SELECT next_page FROM youzan_order_sync_cursors')).rows[0].next_page, 5);
});
const row = (version,payment) => ({ shop_id:shop,kdt_id:7,tid:'t1',payment,source_updated_at:version,status:'TRADE_SUCCESS',raw:{} });
async function commit(owner,rows) {
  return (await db.query('SELECT youzan_commit_order_sync_batch($1,$2,$3::jsonb) AS result',[cursor,owner,JSON.stringify(rows)])).rows[0].result;
}
test('expired worker cannot write; older source cannot overwrite accepted current source', async () => {
  await reset();
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)");
  await db.exec("UPDATE youzan_order_sync_cursors SET lease_expires_at=now()-interval '1 second'");
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('b',120)");
  await commit('b',[row('2026-09-07T12:00:00Z',200)]);
  await assert.rejects(() => commit('a',[row('2026-09-07T11:00:00Z',100)]), /lease_lost/);
  await commit('b',[row('2026-09-07T11:00:00Z',100)]);
  assert.equal(Number((await db.query('SELECT payment FROM youzan_orders')).rows[0].payment), 200);
});
test('unknown source version rolls whole batch back, not partial writes', async () => {
  await reset();
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)");
  await assert.rejects(() => commit('a',[row('2026-09-07T12:00:00Z',200),{...row(null,10),tid:'t2'}]), /source_updated_at/);
  assert.equal((await db.query('SELECT * FROM youzan_orders')).rows.length,0);
});
test('paginated continuation retains scan_end and records watermark only on final page',async()=>{
  await reset();
  const first=(await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)")).rows[0];
  await db.query("SELECT youzan_advance_order_sync_cursor($1,'a','pending',3,'v',20,0,NULL)",[cursor]);
  const middle=(await db.query('SELECT * FROM youzan_order_sync_cursors')).rows[0];
  assert.equal(middle.last_completed_scan_end,null);
  const second=(await db.query("SELECT * FROM youzan_claim_order_sync_cursor('b',120)")).rows[0];
  assert.equal(second.next_page,3);
  assert.deepEqual(second.scan_end,first.scan_end);
  await db.query("SELECT youzan_advance_order_sync_cursor($1,'b','done',3,'v',0,0,NULL)",[cursor]);
  const last=(await db.query('SELECT * FROM youzan_order_sync_cursors')).rows[0];
  assert.deepEqual(last.last_completed_scan_end,first.scan_end);
  assert.ok(last.last_completed_at);
  assert.equal(last.status,'pending');
});
test('eighth actual failure commits terminal failed and cannot claim again',async()=>{
  await reset();
  await db.exec('UPDATE youzan_order_sync_cursors SET attempts=7');
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)");
  assert.equal((await db.query("SELECT youzan_advance_order_sync_cursor($1,'a','failed',1,'v',0,8,'api_error') AS applied",[cursor])).rows[0].applied,true);
  assert.equal((await db.query("SELECT * FROM youzan_claim_order_sync_cursor('b',120)")).rows.length,0);
});
test('closed-window rearm retains honest prior watermark, failed rescan never advances it',async()=>{
  await reset();
  await db.exec("UPDATE youzan_order_sync_cursors SET window_end=now()-interval '2 hours'");
  const first=(await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)")).rows[0];
  await db.query("SELECT youzan_advance_order_sync_cursor($1,'a','done',1,'v',0,0,NULL)",[cursor]);
  await db.exec("UPDATE youzan_order_sync_cursors SET last_completed_at=now()-interval '1 hour'");
  const windows=(await db.query('SELECT shop_id,window_start,window_end FROM youzan_order_sync_cursors')).rows;
  await db.query('SELECT youzan_enqueue_order_sync_windows($1::jsonb)',[JSON.stringify(windows)]);
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('b',120)");
  await db.query("SELECT youzan_advance_order_sync_cursor($1,'b','error',1,'v',0,1,'network')",[cursor]);
  const after=(await db.query('SELECT * FROM youzan_order_sync_cursors')).rows[0];
  assert.deepEqual(after.last_completed_scan_end,first.window_end);
  assert.equal(after.status,'error');
});
test('same-source replay does not overwrite stored data or local updated_at',async()=>{
  await reset();
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)");
  await commit('a',[row('2026-09-07T12:00:00Z',200)]);
  const before=(await db.query('SELECT payment,updated_at FROM youzan_orders')).rows[0];
  await commit('a',[row('2026-09-07T12:00:00Z',100)]);
  assert.deepEqual((await db.query('SELECT payment,updated_at FROM youzan_orders')).rows[0],before);
});
test('legacy/manual row source timestamp in raw also fences an older queued version',async()=>{
  await reset();
  await db.query("INSERT INTO youzan_orders(shop_id,kdt_id,tid,payment,raw) VALUES ($1,7,'t1',300,$2::jsonb)",[
    shop,JSON.stringify({full_order_info:{order_info:{update_time:'2026-09-07 21:00:00'}}}),
  ]);
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)");
  await commit('a',[row('2026-09-07T12:00:00Z',200)]);
  assert.equal(Number((await db.query('SELECT payment FROM youzan_orders')).rows[0].payment),300);
});
test('manual newer raw cannot allow stale queue replay into inventory acceptance',async()=>{
  await reset();
  await db.query("SELECT * FROM youzan_claim_order_sync_cursor('a',120)");
  await commit('a',[row('2026-09-07T12:00:00Z',200)]);
  await db.query("UPDATE youzan_orders SET payment=300,raw=$1::jsonb",[JSON.stringify({modified:'2026-09-07 21:00:00'})]);
  assert.deepEqual(await commit('a',[row('2026-09-07T12:00:00Z',200)]),[]);
});
