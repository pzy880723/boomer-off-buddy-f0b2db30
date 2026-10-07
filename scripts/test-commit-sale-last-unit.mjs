import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// In-memory PostgreSQL only; no production credentials or network calls.
const db = new PGlite();
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const sql = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const migrationName = "20260927114225_commit_sale_last_unit_delist.sql";
before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE TABLE inv_skus(id uuid PRIMARY KEY, stock_qty integer NOT NULL DEFAULT 0,
      inventory_policy text NOT NULL DEFAULT 'tracked', is_custom_price boolean NOT NULL DEFAULT true,
      kind text NOT NULL DEFAULT 'single', is_display boolean NOT NULL DEFAULT true,
      sales_state text NOT NULL DEFAULT 'active', inventory_version bigint NOT NULL DEFAULT 0,
      updated_at timestamptz DEFAULT now());
    CREATE TABLE inv_locations(id uuid PRIMARY KEY, kind text NOT NULL, shop_id uuid);
    CREATE TABLE inv_stocks(sku_id uuid REFERENCES inv_skus, location_id uuid REFERENCES inv_locations,
      qty integer NOT NULL DEFAULT 0, updated_at timestamptz DEFAULT now(), PRIMARY KEY(sku_id,location_id));
    CREATE TABLE inv_stock_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sku_id uuid REFERENCES inv_skus, location_id uuid NOT NULL REFERENCES inv_locations,
      delta integer NOT NULL, balance_after integer NOT NULL, ref_type text NOT NULL, ref_id uuid,
      epc text, note text, created_by uuid);
    CREATE TABLE inventory_sale_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_channel text NOT NULL, source_order_id text NOT NULL, event_type text NOT NULL,
      source_shop_id uuid, sku_id uuid REFERENCES inv_skus, epc text, raw_payload jsonb,
      status text CHECK(status IN ('received','processed','unmatched','oversold','failed')),
      error text, processed_at timestamptz, UNIQUE(source_channel,source_order_id,event_type));
    CREATE TABLE commerce_listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid REFERENCES inv_skus,
      location_id uuid, product_type text, status text, sold_at timestamptz, updated_at timestamptz);
    CREATE TABLE sku_channel_listings(id uuid PRIMARY KEY, sku_id uuid REFERENCES inv_skus,
      channel text, shop_id uuid, listing_status text);
    CREATE TABLE channel_sync_outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku_id uuid REFERENCES inv_skus,
      channel_listing_id uuid, channel text, shop_id uuid, action text, priority integer,
      inventory_version bigint, target_stock integer, dedupe_key text UNIQUE);
    CREATE TABLE youzan_stock_sync_queue(sku_id uuid,shop_id uuid,location_id uuid,target_stock integer,
      action text,reason text,status text,next_run_at timestamptz,last_error text,updated_at timestamptz);
    CREATE UNIQUE INDEX uq_stock_pending ON youzan_stock_sync_queue(sku_id,shop_id)
      WHERE status IN ('pending','failed');
  `);
  const movementSQL = await sql("20260804181500_handheld_custom_storefront_atomic_publish.sql");
  for (const name of ["sync_handheld_custom_listing", "inv_apply_movement"]) {
    const definition = movementSQL.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
    assert.ok(definition, name);
    await db.exec(definition[0]);
  }
  const triggerSQL = await sql("20260704153607_2bcd80da-32a6-4e15-8827-2263637eacf3.sql");
  await db.exec(triggerSQL.match(/CREATE OR REPLACE FUNCTION public\.tg_shop_movement_enqueue\([\s\S]*?\n\$\$;/)[0]);
  await db.exec(`CREATE TRIGGER trg_shop_movement_enqueue AFTER INSERT ON inv_stock_movements
    FOR EACH ROW EXECUTE FUNCTION tg_shop_movement_enqueue();`);
  await db.exec(await sql("20260804190000_commit_sale_location_stock.sql"));
  await db.exec(await sql(migrationName));
  await db.exec(await readFile(new URL('../drizzle/migrations/0042_commit_youzan_sale_line_v2.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await db.exec(`RESET ROLE;
    TRUNCATE youzan_stock_sync_queue,channel_sync_outbox,sku_channel_listings,commerce_listings,inventory_sale_events,
      inv_stock_movements,inv_stocks,inv_locations,inv_skus CASCADE;
    ALTER TABLE inv_stock_movements ALTER COLUMN location_id SET NOT NULL;`);
  // Live shop stock has no rollup trigger; this old aggregate can remain positive.
  await db.query("INSERT INTO inv_skus(id,stock_qty) VALUES($1,1)", [id(1)]);
  await db.query("INSERT INTO inv_locations VALUES($1,'shop',$3),($2,'shop',$4)", [id(2),id(3),id(20),id(30)]);
  await db.query("INSERT INTO inv_stocks(sku_id,location_id,qty) VALUES($1,$2,1)", [id(1),id(2)]);
  await db.query("INSERT INTO commerce_listings(sku_id,location_id,product_type,status) VALUES($1,$2,'custom','published')", [id(1),id(2)]);
  await db.query("INSERT INTO sku_channel_listings VALUES($1,$3,'youzan',$4,'published'),($2,$3,'online',$5,'shelved')", [id(4),id(5),id(1),id(20),id(30)]);
});
after(async () => { await db.close(); });
const rows = (query, args = []) => db.query(query, args).then(r => r.rows);
const sku = () => rows("SELECT * FROM inv_skus WHERE id=$1", [id(1)]).then(r => r[0]);
const sale = (order = "order-1", location = id(2)) => rows(
  "SELECT commit_sale($1,'youzan',$2,$3,'sale','EPC',$4,'{\"test\":true}') AS result",
  [id(1),order,id(20),location],
).then(r => r[0].result);
const youzanSale = (key, legacy = null, item = 11) => rows(
  "SELECT commit_youzan_sale_line($1,'youzan_branch_offline',$2,$3,$4,$5,jsonb_build_object('item_id',$6::int,'unit_index',0)) AS result",
  [id(1),key,legacy,id(20),id(2),item],
).then(r => r[0].result);

test('real commit_sale wrapper recognises a reordered legacy sale after restocking, without a second debit', async () => {
  assert.equal((await youzanSale('T1#0#0')).ok, true);
  await db.exec("UPDATE inv_stocks SET qty=1; UPDATE inv_skus SET is_display=true,sales_state='active'");
  const repeat = await youzanSale('T1#oid:A#0','T1#1#0');
  assert.equal(repeat.ok,true); assert.equal(repeat.idempotent,true);
  assert.equal((await rows('SELECT qty FROM inv_stocks'))[0].qty,1);
  assert.equal((await rows('SELECT * FROM inv_stock_movements')).length,1);
});
test('real commit_sale wrapper rejects ambiguous old lines instead of deducting another unit', async () => {
  await db.query(`INSERT INTO inventory_sale_events(source_channel,source_order_id,event_type,sku_id,raw_payload,status)
    VALUES('youzan_branch_offline','T2#0#0','paid',$1,'{"item_id":11}','processed'),
          ('youzan_branch_offline','T2#1#0','paid',$1,'{"item_id":11}','processed')`,[id(1)]);
  const result = await youzanSale('T2#oid:A#0','T2#2#0');
  assert.equal(result.ok,false); assert.equal(result.error,'ambiguous_legacy');
  assert.equal((await rows('SELECT qty FROM inv_stocks'))[0].qty,1);
  assert.equal((await rows('SELECT * FROM inv_stock_movements')).length,0);
});
test('real wrapper retries an oversold event with one audited debit and then remains idempotent', async () => {
  await db.exec('UPDATE inv_stocks SET qty=0');
  assert.equal((await youzanSale('T3#oid:A#0')).ok,false);
  await db.exec('UPDATE inv_stocks SET qty=1');
  assert.equal((await youzanSale('T3#oid:A#0')).ok,true);
  assert.equal((await youzanSale('T3#oid:A#0')).idempotent,true);
  assert.equal((await rows('SELECT qty FROM inv_stocks'))[0].qty,0);
  assert.equal((await rows('SELECT * FROM inv_stock_movements')).length,1);
  assert.equal((await rows("SELECT * FROM inventory_sale_events WHERE source_order_id='T3#oid:A#0~retry1' AND status='oversold'")).length,1);
});

test("last custom unit atomically hides SKU, sells listing, zeros source and queues all-channel delist", async () => {
  const result = await sale(); assert.equal(result.ok, true);
  const item = await sku(); assert.equal(item.is_display, false); assert.equal(item.sales_state, "sold_syncing");
  assert.equal(item.stock_qty,0,"exhausted custom clears stale aggregate shown by ERP ProductCard");
  assert.equal(Number(item.inventory_version), 1);
  assert.equal((await rows("SELECT qty FROM inv_stocks"))[0].qty, 0);
  const [listing] = await rows("SELECT * FROM commerce_listings");
  assert.equal(listing.status, "sold"); assert.ok(listing.sold_at);
  assert.deepEqual((await rows("SELECT action,target_stock FROM channel_sync_outbox ORDER BY action")), [
    {action:"delist",target_stock:null},{action:"delist",target_stock:null},
    {action:"set_stock_zero",target_stock:0},{action:"set_stock_zero",target_stock:0},
  ]);
  const [movement] = await rows("SELECT * FROM inv_stock_movements");
  assert.equal(movement.delta,-1); assert.equal(movement.balance_after,0);
  assert.equal(movement.location_id,id(2)); assert.equal(movement.ref_type,"sale:youzan");
  assert.equal(movement.note,"commit_sale order-1"); assert.equal(movement.epc,"EPC");
  assert.deepEqual((await rows("SELECT raw_payload FROM inventory_sale_events"))[0].raw_payload,{test:true});
  assert.deepEqual(await rows("SELECT target_stock,shop_id,location_id FROM youzan_stock_sync_queue"),[
    {target_stock:0,shop_id:id(20),location_id:id(2)},
  ]);
});
test("replayed sale does not debit stock or duplicate audit/outbox", async () => {
  const first = await sale(); const replay = await sale();
  assert.equal(replay.ok,true); assert.equal(replay.idempotent,true); assert.equal(replay.event_id,first.event_id);
  assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,1);
  assert.equal((await rows("SELECT * FROM inventory_sale_events")).length,1);
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,4);
  assert.equal(Number((await sku()).inventory_version),1);
});
for (const custom of [true,false]) {
  test(`${custom ? "custom" : "standard"} with remaining units stays active and has no zero/delist tasks`, async () => {
    await db.query("UPDATE inv_skus SET is_custom_price=$1", [custom]);
    await db.exec("UPDATE inv_stocks SET qty=2");
    assert.equal((await sale()).ok,true);
    assert.equal((await sku()).sales_state,"active"); assert.equal((await sku()).is_display,true);
    assert.equal((await rows("SELECT status FROM commerce_listings"))[0].status,"published");
    assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
    assert.equal((await rows("SELECT target_stock FROM youzan_stock_sync_queue"))[0].target_stock,1);
    assert.equal((await sale("order-2")).ok,true);
    assert.equal((await rows("SELECT qty FROM inv_stocks"))[0].qty,0);
    assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,2);
  });
}
test("positive stock in another location prevents global delist", async () => {
  await db.query("INSERT INTO inv_stocks(sku_id,location_id,qty) VALUES($1,$2,1)",[id(1),id(3)]);
  assert.equal((await sale()).ok,true);
  assert.equal((await sku()).is_display,true); assert.equal((await sku()).sales_state,"active");
  assert.equal((await sku()).stock_qty,1,"remaining custom stock retains aggregate semantics");
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
});
test("exhausted standard stock does not rewrite the warehouse aggregate", async () => {
  await db.exec("UPDATE inv_skus SET is_custom_price=false,stock_qty=7");
  assert.equal((await sale()).ok,true);
  assert.equal((await rows("SELECT qty FROM inv_stocks"))[0].qty,0);
  assert.equal((await sku()).stock_qty,7);
});
test("negative stock elsewhere cannot cancel available positive units", async () => {
  await db.exec("UPDATE inv_stocks SET qty=2");
  await db.query("INSERT INTO inv_stocks(sku_id,location_id,qty) VALUES($1,$2,-1)",[id(1),id(3)]);
  assert.equal((await sale()).ok,true); assert.equal((await sku()).sales_state,"active");
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
});
test("legacy nullable-location schema preserves movement and only delists on exhaustion", async () => {
  // Compatibility branch only: live currently forbids NULL movement locations.
  await db.exec("ALTER TABLE inv_stock_movements ALTER COLUMN location_id DROP NOT NULL; DELETE FROM inv_stocks; UPDATE inv_skus SET stock_qty=2");
  assert.equal((await sale("legacy-1",null)).ok,true);
  assert.equal((await sku()).stock_qty,1); assert.equal((await sku()).sales_state,"active");
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
  assert.equal((await sale("legacy-2",null)).ok,true); assert.equal((await sku()).is_display,false);
  assert.equal((await rows("SELECT location_id FROM inv_stock_movements"))[0].location_id,null);
});
test("unlimited standard stock is never globally marked sold by this path", async () => {
  await db.exec("UPDATE inv_skus SET inventory_policy='unlimited',is_custom_price=false");
  assert.equal((await sale()).ok,true); assert.equal((await sku()).sales_state,"active");
  assert.equal((await sku()).is_display,true);
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
});
test("legacy no-location zero aggregate does not hide positive location inventory", async () => {
  await db.exec("ALTER TABLE inv_stock_movements ALTER COLUMN location_id DROP NOT NULL");
  assert.equal((await sale("legacy",null)).ok,true);
  assert.equal((await sku()).stock_qty,0); assert.equal((await sku()).is_display,true);
  assert.equal((await sku()).sales_state,"active");
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
});
test("live NOT NULL movement constraint still rolls back tracked no-location calls", async () => {
  await assert.rejects(sale("legacy",null), /null value in column "location_id"/);
  assert.equal((await sku()).stock_qty,1); assert.equal((await sku()).is_display,true);
  assert.equal((await rows("SELECT * FROM inventory_sale_events")).length,0);
});
for (const location of ["zero","missing","none"]) {
  test(`unlimited standard sale with ${location} stock is audited once without inventory writes`, async () => {
    await db.exec("UPDATE inv_skus SET inventory_policy='unlimited',is_custom_price=false,stock_qty=0; UPDATE inv_stocks SET qty=0");
    if (location === "missing") await db.exec("DELETE FROM inv_stocks");
    const target = location === "none" ? null : id(2);
    const first = await sale("unlimited",target); assert.equal(first.ok,true);
    const replay = await sale("unlimited",target); assert.equal(replay.idempotent,true); assert.equal(replay.event_id,first.event_id);
    assert.equal((await sku()).stock_qty,0); assert.equal((await sku()).is_display,true);
    assert.equal((await sku()).sales_state,"active");
    assert.equal((await rows("SELECT * FROM inventory_sale_events WHERE status='processed'")).length,1);
    assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,0);
    assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
    assert.equal((await rows("SELECT * FROM youzan_stock_sync_queue")).length,0);
    assert.equal((await rows("SELECT * FROM inv_stocks WHERE qty<>0")).length,0);
    assert.equal((await rows("SELECT status FROM commerce_listings"))[0].status,"published");
  });
}
test("warehouse sale uses real remaining stock and preserves aggregate movement", async () => {
  await db.exec("UPDATE inv_locations SET kind='warehouse'; UPDATE inv_stocks SET qty=2; UPDATE inv_skus SET stock_qty=2");
  assert.equal((await sale()).ok,true); assert.equal((await sku()).stock_qty,1);
  assert.equal((await sku()).sales_state,"active");
  assert.equal((await sale("warehouse-last")).ok,true); assert.equal((await sku()).stock_qty,0);
  assert.equal((await sku()).is_display,false);
  assert.equal((await rows("SELECT * FROM youzan_stock_sync_queue")).length,0);
});
test("oversold rejection and replay do not change inventory/display", async () => {
  await db.exec("UPDATE inv_stocks SET qty=0");
  assert.equal((await sale()).error,"oversold"); assert.equal((await sale()).idempotent,true);
  assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,0);
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
  assert.equal((await sku()).is_display,true);
});
test("downstream failure rolls back debit, display, movement and sale event together", async () => {
  await db.exec("ALTER TABLE channel_sync_outbox ADD CONSTRAINT test_failure CHECK(action <> 'delist')");
  try {
    await assert.rejects(sale(), /test_failure/);
    assert.equal((await rows("SELECT qty FROM inv_stocks"))[0].qty,1);
    assert.equal((await sku()).is_display,true); assert.equal(Number((await sku()).inventory_version),0);
    assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,0);
    assert.equal((await rows("SELECT * FROM inventory_sale_events")).length,0);
    assert.equal((await rows("SELECT * FROM youzan_stock_sync_queue")).length,0);
    assert.equal((await rows("SELECT status FROM commerce_listings"))[0].status,"published");
  } finally { await db.exec("ALTER TABLE channel_sync_outbox DROP CONSTRAINT test_failure"); }
});
test("event lookup is repeated after SKU row lock and before stock mutation", async () => {
  // PGlite has one connection: assert lock order, not a claim of multi-session coverage.
  const [row] = await rows("SELECT pg_get_functiondef('commit_sale(uuid,text,text,uuid,text,text,uuid,jsonb)'::regprocedure) AS definition");
  const afterLock = row.definition.slice(row.definition.indexOf("FOR UPDATE;"));
  const eventLookup = afterLock.indexOf("FROM public.inventory_sale_events");
  assert.ok(eventLookup >= 0, "must recheck the event after waiting for SKU lock");
  assert.ok(eventLookup < afterLock.indexOf("public.inv_apply_movement("));
});
test("RPC remains service-only", async () => {
  for (const role of ["anon","authenticated","service_role"]) {
    const [row] = await rows("SELECT has_function_privilege($1,'commit_sale(uuid,text,text,uuid,text,text,uuid,jsonb)','EXECUTE') AS allowed",[role]);
    assert.equal(row.allowed,role === "service_role");
  }
});

const oldOversold = async () => {
  await db.query(`INSERT INTO inventory_sale_events(id,source_channel,source_order_id,event_type,
    source_shop_id,sku_id,epc,raw_payload,status,error,processed_at)
    VALUES($1,'youzan','old-unlimited','sale',$2,$3,'EPC','{"original":true}',
      'oversold','insufficient stock or already sold','2026-09-26T00:00:00Z')`,[id(50),id(20),id(1)]);
};
test("real replay repairs only the old unlimited oversold event, retaining original evidence", async () => {
  await db.exec("UPDATE inv_skus SET inventory_policy='unlimited',is_custom_price=false,stock_qty=0; DELETE FROM inv_stocks");
  await oldOversold();
  const result = await sale("old-unlimited");
  assert.equal(result.ok,true); assert.equal(result.idempotent,true); assert.equal(result.event_id,id(50));
  const [event] = await rows("SELECT * FROM inventory_sale_events");
  assert.equal(event.status,"processed"); assert.equal(event.error,null);
  assert.deepEqual(event.raw_payload.original_raw_payload,{original:true});
  const audit = event.raw_payload.unlimited_oversold_replay;
  assert.equal(audit.original_error,"insufficient stock or already sold");
  assert.equal(audit.original_status,"oversold"); assert.ok(audit.original_processed_at); assert.ok(audit.replayed_at);
  assert.deepEqual(audit.replay_raw_payload,{test:true});
  const firstPayload = event.raw_payload;
  assert.equal((await sale("old-unlimited")).ok,true);
  assert.deepEqual((await rows("SELECT raw_payload FROM inventory_sale_events"))[0].raw_payload,firstPayload);
  assert.equal((await rows("SELECT * FROM inventory_sale_events")).length,1);
  assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,0);
  assert.equal((await rows("SELECT * FROM channel_sync_outbox")).length,0);
  assert.equal((await rows("SELECT * FROM youzan_stock_sync_queue")).length,0);
  assert.equal(Number((await sku()).inventory_version),0);
  assert.equal((await sku()).is_display,true); assert.equal((await sku()).sales_state,"active");
});
test("old tracked oversold remains explicit failure on replay", async () => {
  await oldOversold();
  const result = await sale("old-unlimited");
  assert.equal(result.ok,false); assert.equal(result.status,"oversold");
  assert.equal((await rows("SELECT error FROM inventory_sale_events"))[0].error,"insufficient stock or already sold");
  assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,0);
});
test("old unlimited oversold with an actual matching debit is never auto-confirmed", async () => {
  await db.exec("UPDATE inv_skus SET inventory_policy='unlimited',is_custom_price=false");
  await oldOversold();
  await db.query(`INSERT INTO inv_stock_movements(sku_id,location_id,delta,balance_after,ref_type,note)
    VALUES($1,$2,-1,0,'sale:youzan','commit_sale old-unlimited')`,[id(1),id(2)]);
  const result = await sale("old-unlimited"); assert.equal(result.ok,false); assert.equal(result.status,"oversold");
  assert.equal((await rows("SELECT status FROM inventory_sale_events"))[0].status,"oversold");
  assert.equal((await rows("SELECT * FROM inv_stock_movements")).length,1);
});
test("old event for a different SKU is not reinterpreted as this unlimited SKU", async () => {
  await oldOversold();
  await db.query("INSERT INTO inv_skus(id,inventory_policy,is_custom_price) VALUES($1,'unlimited',false)",[id(99)]);
  const [row] = await rows("SELECT commit_sale($1,'youzan','old-unlimited') AS result",[id(99)]);
  assert.equal(row.result.ok,false); assert.equal(row.result.status,"oversold");
  assert.equal((await rows("SELECT status FROM inventory_sale_events"))[0].status,"oversold");
});
test("replay of one unlimited event does not batch rewrite other old oversold events", async () => {
  await db.exec("UPDATE inv_skus SET inventory_policy='unlimited',is_custom_price=false");
  await oldOversold();
  await db.query(`INSERT INTO inventory_sale_events(source_channel,source_order_id,event_type,sku_id,status,error)
    VALUES('youzan','not-replayed','sale',$1,'oversold','keep evidence')`,[id(1)]);
  assert.equal((await sale("old-unlimited")).ok,true);
  assert.deepEqual(await rows("SELECT status,error FROM inventory_sale_events WHERE source_order_id='not-replayed'"),[
    {status:"oversold",error:"keep evidence"},
  ]);
});
