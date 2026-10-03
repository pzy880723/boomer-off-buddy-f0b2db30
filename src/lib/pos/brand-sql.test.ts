import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, beforeEach, afterEach, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20261003113334_pos_sale_brand_tags.sql");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
before(async () => {
  await db.exec(read("tests/sql/pos-points-fixture.sql"));
  await db.exec(read("supabase/migrations/20260728120000_pos_member_discount_workflows.sql"));
  const legacy = read("supabase/migrations/20260803142151_f090c669-5831-41ec-aa6d-cc9f4a039f02.sql");
  await db.exec(legacy.slice(legacy.indexOf("CREATE OR REPLACE FUNCTION public.pos_complete_sale(")));
  await db.exec(read("supabase/migrations/20261002174301_pos_points_redemption.sql"));
  for (const fn of JSON.parse(read("tests/backend/pos-brand-production-baseline.json")).functions) await db.exec(fn.definition);
  await db.exec(`CREATE TABLE inv_brands(id uuid PRIMARY KEY,name text,status text,entity_type text);
    ALTER TABLE pos_held_cart_items ADD COLUMN subcategory_code text;
    ALTER TABLE pos_held_cart_items DROP CONSTRAINT IF EXISTS pos_held_cart_items_held_cart_id_sku_id_key;
    CREATE UNIQUE INDEX pos_held_cart_items_line_key ON pos_held_cart_items(held_cart_id,sku_id,coalesce(subcategory_code,''));`);
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(`INSERT INTO inv_locations VALUES ('${id(1)}');
    INSERT INTO commerce_customers VALUES ('${id(2)}','active');
    INSERT INTO pos_registers(id) VALUES ('${id(3)}');
    INSERT INTO pos_shifts(id,location_id,operator_id,register_id) VALUES ('${id(4)}','${id(1)}','${id(5)}','${id(3)}');
    INSERT INTO inv_skus(id,price_tier) VALUES ('${id(6)}',10);
    INSERT INTO inv_stocks VALUES ('${id(6)}','${id(1)}',100);
    INSERT INTO pos_customer_wallets(customer_id,points) VALUES ('${id(2)}',1000);
    INSERT INTO commerce_membership_plans(id,code,tier_code,points_redemption_cap_rate,
      points_redemption_enabled,points_redemption_points_per_unit,points_redemption_unit_fen)
      VALUES ('${id(7)}','free','free',0.15,true,10,100);
    INSERT INTO inv_brands VALUES ('${id(8)}','Brand A','active','brand'),('${id(9)}','Brand B','active','kiln'),
      ('${id(10)}','Disabled','inactive','brand'),('${id(11)}','Character','active','ip');`);
});
beforeEach(() => db.exec("BEGIN"));
afterEach(() => db.exec("ROLLBACK"));
after(() => db.close());
async function sale(items: unknown[], points = 0) {
  return (await db.query<any>(`SELECT pos_complete_sale_v3($1,$2,'brand-sale',$3::jsonb,$4::jsonb,$5,NULL,'{}','{}',NULL,$6) result`,
    [id(4),id(5),JSON.stringify(items),JSON.stringify([{provider:"cash",amount:items.length*10-points/10}]),id(2),points])).rows[0].result;
}
test("same SKU with two brands stays distinct in orders, receipts, points replay and refund", async () => {
  const items = [8,9].map((n) => ({sku_id:id(6),quantity:1,brand_id:id(n)}));
  const result = await sale(items,10);
  assert.equal((await sale(items,10)).replayed,true);
  const rows = (await db.query<any>("SELECT * FROM commerce_order_items ORDER BY brand_name_snapshot")).rows;
  assert.deepEqual(rows.map((r) => r.brand_name_snapshot),["Brand A","Brand B"]);
  assert.deepEqual(new Set(result.items.map((r: any) => r.brand_id)),new Set([id(8),id(9)]));
  assert.equal((await db.query<any>("SELECT qty FROM inv_stocks")).rows[0].qty,98);
  for (const row of rows) await db.query(`SELECT pos_complete_return($1,$2,$3,$4,$5::jsonb,'test',NULL)`,
    [id(4),id(5),result.order_id,`refund-${row.id}`,JSON.stringify([{order_item_id:row.id,quantity:1}])]);
  assert.equal((await db.query<any>("SELECT qty FROM inv_stocks")).rows[0].qty,100);
  assert.equal((await db.query<any>("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
});
test("null brands remain compatible; no values are invented", async () => {
  await sale([{sku_id:id(6),quantity:1}]);
  const row = (await db.query<any>("SELECT brand_id,brand_name_snapshot FROM commerce_order_items")).rows[0];
  assert.deepEqual(row,{brand_id:null,brand_name_snapshot:null});
});
for (const n of [10,11,99]) test(`invalid brand ${n} rolls back sale, payment and stock`,async () => {
  await db.exec("SAVEPOINT invalid_brand");
  await assert.rejects(sale([{sku_id:id(6),quantity:1,brand_id:id(n)}]),/invalid_brand/);
  await db.exec("ROLLBACK TO SAVEPOINT invalid_brand");
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM commerce_orders")).rows[0].n,0);
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM commerce_payments")).rows[0].n,0);
  assert.equal((await db.query<any>("SELECT qty FROM inv_stocks")).rows[0].qty,100);
});
test("held cart unique key separates brands but rejects duplicate same-brand lines",async () => {
  await db.exec(`INSERT INTO pos_held_carts(id,shift_id,location_id,operator_id,client_op_id)
    VALUES ('${id(20)}','${id(4)}','${id(1)}','${id(5)}','held-brand');
    INSERT INTO pos_held_cart_items(held_cart_id,sku_id,quantity,price_snapshot,brand_id,brand_name_snapshot)
    VALUES ('${id(20)}','${id(6)}',1,10,'${id(8)}','Brand A'),('${id(20)}','${id(6)}',1,10,'${id(9)}','Brand B');`);
  assert.equal((await db.query<any>("SELECT count(*)::int n FROM pos_held_cart_items")).rows[0].n,2);
  await assert.rejects(db.exec(`INSERT INTO pos_held_cart_items(held_cart_id,sku_id,quantity,price_snapshot,brand_id)
    VALUES ('${id(20)}','${id(6)}',1,10,'${id(8)}')`),/unique/);
});
