import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Disposable, in-memory PostgreSQL only. Never read project credentials.
const runtime = process.env.QUEUE_PGLITE_MODULE;
if (!runtime) throw Error('Set QUEUE_PGLITE_MODULE to a locally installed @electric-sql/pglite/dist/index.js');
const { PGlite } = await import(pathToFileURL(runtime).href);
const db = new PGlite();
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const shopA = '00000000-0000-0000-0000-00000000000a';
const shopB = '00000000-0000-0000-0000-00000000000b';
const TODAY = '00000000-0000-0000-0000-0000000000a1';
const HIST = '00000000-0000-0000-0000-0000000000b1';
const HIST2 = '00000000-0000-0000-0000-0000000000b2';

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE youzan_shops(id uuid PRIMARY KEY, kdt_id bigint);
    INSERT INTO youzan_shops VALUES ('${shopA}', 7), ('${shopB}', 8);
    CREATE FUNCTION tg_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
    CREATE FUNCTION has_role(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
  `);
  await db.exec(read('../../../supabase/migrations/20260907171328_5868ff69-1e58-4b13-b748-75fb350258f3.sql'));
  await db.exec(read('../../../supabase/migrations/20260907174126_17d01aa9-c7ae-4f38-b4b7-e77a3f09677a.sql').split('-- 4)')[0]);
  await db.exec(read('../../../supabase/migrations/20260521232657_6b4185e8-b362-415d-9310-5059b740a9e5.sql').split('-- 有赞商品')[0]);
  await db.exec(read('../../../supabase/migrations/20260523052635_3b1abe44-8248-44fc-b9ae-72a9236ece2e.sql'));
  await db.exec(read('../../../supabase/migrations/20260907191142_7d0f83df-f771-49f6-a846-10100a7b4151.sql'));
  await db.exec(read('../../../supabase/migrations/20260927114320_youzan_order_fast_schedule.sql'));
  await db.exec(read('../../../drizzle/migrations/0036_youzan_order_claim_fairness.sql').replaceAll('--> statement-breakpoint', ''));
});
after(() => db.close());

// Today's Shanghai window as a UTC day containing now (straddles local midnight like prod).
const todayWindow = `date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`;
async function seed({ todayCompletedAgo, todayNextRunAgo = '30 seconds', histNextRunAgo = '3 hours' }) {
  await db.exec('DELETE FROM youzan_order_sync_cursors;');
  const lcse = todayCompletedAgo === null ? 'NULL' : `now()-interval '${todayCompletedAgo}'`;
  await db.exec(`
    INSERT INTO youzan_order_sync_cursors(id,shop_id,window_start,window_end,status,next_run_at,last_completed_scan_end)
    VALUES ('${TODAY}','${shopA}',${todayWindow},${todayWindow}+interval '1 day','pending',now()-interval '${todayNextRunAgo}',${lcse}),
           ('${HIST}','${shopA}',${todayWindow}-interval '20 days',${todayWindow}-interval '19 days','pending',now()-interval '${histNextRunAgo}',NULL);
  `);
}
const claim = async (w) => (await db.query(`SELECT * FROM youzan_claim_order_sync_cursor('${w}',120)`)).rows[0];

test('today window scanned within 5 minutes no longer starves due historical window', async () => {
  await seed({ todayCompletedAgo: '2 minutes' });
  assert.equal((await claim('a')).id, HIST);
  assert.equal((await claim('b')).id, TODAY);
});

test('today window stale beyond 5 minutes keeps real-time priority over older history', async () => {
  await seed({ todayCompletedAgo: '6 minutes' });
  assert.equal((await claim('a')).id, TODAY);
});

test('never-scanned today window keeps priority', async () => {
  await seed({ todayCompletedAgo: null });
  assert.equal((await claim('a')).id, TODAY);
});

test('fresh today and history fall back to due-time order', async () => {
  await seed({ todayCompletedAgo: '1 minute', todayNextRunAgo: '2 hours', histNextRunAgo: '10 minutes' });
  assert.equal((await claim('a')).id, TODAY);
});

test('eligibility unchanged: attempts>=8, failed, future next_run_at and live lease are skipped', async () => {
  await seed({ todayCompletedAgo: '2 minutes' });
  await db.exec(`UPDATE youzan_order_sync_cursors SET attempts=8 WHERE id='${HIST}'`);
  assert.equal((await claim('a')).id, TODAY);
  await seed({ todayCompletedAgo: '2 minutes' });
  await db.exec(`UPDATE youzan_order_sync_cursors SET status='failed' WHERE id='${HIST}'`);
  await db.exec(`UPDATE youzan_order_sync_cursors SET next_run_at=now()+interval '1 minute' WHERE id='${TODAY}'`);
  assert.equal(await claim('a'), undefined);
  await seed({ todayCompletedAgo: '2 minutes' });
  await db.exec(`UPDATE youzan_order_sync_cursors SET status='running',lease_owner='x',lease_expires_at=now()+interval '1 minute' WHERE id='${HIST}'`);
  assert.equal((await claim('a')).id, TODAY);
  await db.exec(`UPDATE youzan_order_sync_cursors SET lease_expires_at=now()-interval '1 second' WHERE id='${HIST}'`);
  const reclaimed = await claim('b');
  assert.equal(reclaimed.id, HIST);
  assert.equal(reclaimed.lease_owner, 'b');
});

test('claimed row gets lease and fixed scan_end capped at now-1min', async () => {
  await seed({ todayCompletedAgo: '10 minutes' });
  const c = await claim('a');
  assert.equal(c.status, 'running');
  assert.ok(new Date(c.scan_end) < new Date(c.window_end));
  assert.ok(new Date(c.lease_expires_at) > new Date());
});

test('simulated worker loop drains historical backlog while today still refreshes', async () => {
  await seed({ todayCompletedAgo: '2 minutes' });
  await db.exec(`INSERT INTO youzan_order_sync_cursors(id,shop_id,window_start,window_end,status,next_run_at)
    VALUES ('${HIST2}','${shopB}',${todayWindow}-interval '18 days',${todayWindow}-interval '17 days','pending',now()-interval '2 hours')`);
  const order = [];
  for (const w of ['a', 'b', 'c']) {
    const c = await claim(w);
    order.push(c.id);
    // Closed historical windows finish; today's open window re-arms 1 minute later.
    await db.query("SELECT youzan_advance_order_sync_cursor($1,$2,'done',1,'v',0,0,NULL)", [c.id, w]);
  }
  assert.deepEqual(order.slice(0, 2).sort(), [HIST, HIST2].sort());
  assert.equal(order[2], TODAY);
  const rows = (await db.query('SELECT id,status FROM youzan_order_sync_cursors ORDER BY id')).rows;
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), { [TODAY]: 'pending', [HIST]: 'done', [HIST2]: 'done' });
});
