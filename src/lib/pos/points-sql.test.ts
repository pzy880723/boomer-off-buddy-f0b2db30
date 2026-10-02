import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, before, after } from "node:test";
import { pathToFileURL } from "node:url";
import { calculatePointsReturnPreview } from "./points-return-preview.ts";

const root = new URL("../../../", import.meta.url);
const { PGlite } = await import(process.env.POINTS_PGLITE_MODULE
  ? pathToFileURL(process.env.POINTS_PGLITE_MODULE).href : "@electric-sql/pglite");
const db = new PGlite();
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
before(async () => {
  await db.exec(await readFile(new URL("tests/sql/pos-points-fixture.sql", root), "utf8"));
  await db.exec(await readFile(new URL("supabase/migrations/20260728120000_pos_member_discount_workflows.sql", root), "utf8"));
  const legacy = await readFile(new URL("supabase/migrations/20260803142151_f090c669-5831-41ec-aa6d-cc9f4a039f02.sql", root), "utf8");
  await db.exec(legacy.slice(legacy.indexOf("CREATE OR REPLACE FUNCTION public.pos_complete_sale(")));
  await db.exec(await readFile(new URL("supabase/migrations/20261002174301_pos_points_redemption.sql", root), "utf8"));
  await db.exec(`
    INSERT INTO inv_locations VALUES ('${id(1)}');
    INSERT INTO commerce_customers VALUES ('${id(2)}','active');
    INSERT INTO pos_registers(id) VALUES ('${id(3)}');
    INSERT INTO pos_shifts(id,location_id,operator_id,register_id) VALUES ('${id(4)}','${id(1)}','${id(5)}','${id(3)}');
    INSERT INTO inv_skus(id,price_tier) VALUES ('${id(6)}',10.01);
    INSERT INTO inv_stocks VALUES ('${id(6)}','${id(1)}',100);
    INSERT INTO pos_customer_wallets(customer_id,points) VALUES ('${id(2)}',1000);
    INSERT INTO commerce_membership_plans(id,code,tier_code,points_redemption_cap_rate) VALUES ('${id(7)}','free','free',0.15);
  `);
});
after(() => db.close());
async function sale(op: string, points = 30, amount = 27.03, provider = "cash", customer: string | null = id(2)) {
  return (await db.query(`SELECT pos_complete_sale_v3($1,$2,$3,$4::jsonb,$5::jsonb,$6,NULL,'{}','{}',NULL,$7) AS result`,
    [id(4), id(5), op, JSON.stringify([{ sku_id: id(6), quantity: 3 }]),
      JSON.stringify([{ provider, amount }]), customer, points])).rows[0].result;
}
async function refund(order: string, item: string, op: string, quantity = 1) {
  return (await db.query(`SELECT pos_complete_return($1,$2,$3,$4,$5::jsonb,'test refund',NULL) AS result`,
    [id(4), id(5), order, op, JSON.stringify([{ order_item_id: item, quantity }])])).rows[0].result;
}
test("points migration implements atomic sale and refund RPCs", async () => {
  const migration = await readFile(new URL("supabase/migrations/20261002174301_pos_points_redemption.sql", root), "utf8");
  assert.match(migration, /CREATE OR REPLACE FUNCTION public.pos_complete_sale_v3/);
});
test("default rules disabled, then cash sale atomically redeems and replays", async () => {
  await assert.rejects(sale("disabled"), /points_rule_not_configured/);
  await db.exec(`UPDATE commerce_membership_plans SET points_redemption_enabled=true,points_redemption_points_per_unit=10,points_redemption_unit_fen=100`);
  const first = await sale("cash-1");
  assert.equal(Number(first.total_amount), 27.03);
  assert.equal(first.points_redemption.applied_points, 30);
  assert.equal((await sale("cash-1")).replayed, true);
  await assert.rejects(sale("cash-1", 20, 28.03), /idempotency_conflict/);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points, 970);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM commerce_points_ledger")).rows[0].n, 1);
  assert.equal((await db.query("SELECT qty FROM inv_stocks")).rows[0].qty, 97);
  const item = (await db.query("SELECT id FROM commerce_order_items WHERE order_id=$1", [first.order_id])).rows[0].id;
  for (let i=0;i<3;i++) {
    const result = await refund(first.order_id,item,`refund-${i}`);
    assert.equal(Number(result.refund_total),9.01);
    assert.equal(result.points_restored,10);
    assert.equal((await refund(first.order_id,item,`refund-${i}`)).replayed,true);
  }
  await assert.rejects(refund(first.order_id,item,"over-refund"), /quantity exceeds/);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
  assert.equal((await db.query("SELECT qty FROM inv_stocks")).rows[0].qty,100);
});
test("failed, noncash, missing customer and over-cap requests never charge points", async () => {
  const count = (await db.query("SELECT count(*)::int n FROM commerce_orders")).rows[0].n;
  await assert.rejects(sale("bad-tender",30,1), /tender total/);
  await assert.rejects(sale("async",30,27.03,"wechat"), /points_async_not_supported/);
  await assert.rejects(sale("no-customer",30,27.03,"cash",null), /points_customer_required/);
  await assert.rejects(sale("cap",100,20.03), /points_cap_exceeded/);
  await db.exec("UPDATE inv_stocks SET qty=0");
  await assert.rejects(sale("stock"), /stock/);
  await db.exec("UPDATE inv_stocks SET qty=100");
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
  assert.equal((await db.query("SELECT count(*)::int n FROM commerce_orders")).rows[0].n,count);
});
test("late ledger failure rolls back wallet, order, payment and stock", async () => {
  await db.exec(`CREATE FUNCTION reject_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger offline'; END $$;
    CREATE TRIGGER reject_ledger BEFORE INSERT ON commerce_points_ledger FOR EACH ROW EXECUTE FUNCTION reject_ledger();`);
  await assert.rejects(sale("ledger-failure"),/ledger offline/);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
  assert.equal((await db.query("SELECT qty FROM inv_stocks")).rows[0].qty,100);
  assert.equal((await db.query("SELECT count(*)::int n FROM commerce_orders WHERE idempotency_key='ledger-failure'")).rows[0].n,0);
  await db.exec("DROP TRIGGER reject_ledger ON commerce_points_ledger");
});
test("runtime role grants do not expose privileged RPCs or bypass wrappers", async () => {
  for (const role of ["anon","authenticated"]) {
    const row = (await db.query(`SELECT has_function_privilege($1,'public.pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer)','EXECUTE') AS allowed`,[role])).rows[0];
    assert.equal(row.allowed,false);
  }
  assert.equal((await db.query(`SELECT has_function_privilege('service_role','public.pos_complete_sale_without_points(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)','EXECUTE') AS allowed`)).rows[0].allowed,false);
});
test("partial refunds conserve rounding, failures roll back and historical rules remain frozen", async () => {
  await db.exec("UPDATE commerce_membership_plans SET points_redemption_points_per_unit=3,points_redemption_unit_fen=100");
  const order = await sale("rounding",3,29.03);
  const item = (await db.query("SELECT id FROM commerce_order_items WHERE order_id=$1",[order.order_id])).rows[0].id;
  await db.exec("UPDATE commerce_membership_plans SET points_redemption_enabled=false");
  await db.exec("CREATE TRIGGER reject_ledger BEFORE INSERT ON commerce_points_ledger FOR EACH ROW EXECUTE FUNCTION reject_ledger()");
  await assert.rejects(refund(order.order_id,item,"refund-rollback"),/ledger offline/);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,997);
  assert.equal((await db.query("SELECT qty FROM inv_stocks")).rows[0].qty,97);
  assert.equal((await db.query("SELECT count(*)::int n FROM pos_returns WHERE client_op_id='refund-rollback'")).rows[0].n,0);
  await db.exec("DROP TRIGGER reject_ledger ON commerce_points_ledger");
  const amounts = [];
  for (let i=0;i<3;i++) amounts.push(Number((await refund(order.order_id,item,`rounding-${i}`)).refund_total));
  assert.deepEqual(amounts,[9.67,9.68,9.68]);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
  await db.exec("UPDATE commerce_membership_plans SET points_redemption_enabled=true,points_redemption_points_per_unit=10");
});
test("mixed goods exclude consignment and conserve discount and points across lines", async () => {
  await db.exec(`INSERT INTO inv_skus(id,price_tier,sale_ownership) VALUES ('${id(8)}',10,'consigned');
    INSERT INTO inv_stocks VALUES ('${id(8)}','${id(1)}',10);`);
  const items = [{sku_id:id(6),quantity:1},{sku_id:id(6),quantity:2},{sku_id:id(8),quantity:1}];
  const result = (await db.query(`SELECT pos_complete_sale_v3($1,$2,'mixed',$3::jsonb,'[{"provider":"cash","amount":37.03}]',$4,NULL,'{}','{}',NULL,30) AS result`,
    [id(4),id(5),JSON.stringify(items),id(2)])).rows[0].result;
  const lines = (await db.query("SELECT * FROM commerce_order_items WHERE order_id=$1 ORDER BY id",[result.order_id])).rows;
  assert.equal(lines.reduce((s: number,l: any) => s + Math.round(Number(l.line_total)*100),0),3703);
  assert.equal(lines.reduce((s: number,l: any) => s + (l.discount_snapshot.points_allocated ?? 0),0),30);
  assert.equal(Number(lines.find((l: any) => l.sku_id===id(8)).line_total),10);
  for (const line of lines) await refund(result.order_id,line.id,`mixed-${line.id}`,line.quantity);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
});
test("zero-points v2 sales and refunds preserve legacy behavior", async () => {
  const args = [id(4),id(5),JSON.stringify([{sku_id:id(6),quantity:3}]),id(2)];
  const result = (await db.query(`SELECT pos_complete_sale_v2($1,$2,'zero-points',$3::jsonb,'[{"provider":"cash","amount":30.03}]',$4) AS result`,args)).rows[0].result;
  assert.equal(Number(result.total_amount),30.03);
  const repeated = (await db.query(`SELECT pos_complete_sale_v2($1,$2,'zero-points',$3::jsonb,'[{"provider":"cash","amount":30.03}]',$4) AS result`,args)).rows[0].result;
  assert.equal(repeated.replayed,true);
  const item = (await db.query("SELECT id FROM commerce_order_items WHERE order_id=$1",[result.order_id])).rows[0].id;
  assert.equal(Number((await refund(result.order_id,item,"zero-refund",3)).refund_total),30.03);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
  assert.equal((await db.query("SELECT count(*)::int n FROM commerce_points_ledger WHERE source_id=$1",[result.order_id])).rows[0].n,0);
});
test("combined manual and points savings require authorization, preserve net line and receipt totals", async () => {
  const args = [id(4),id(5),JSON.stringify([{sku_id:id(6),quantity:3}]),id(2)];
  const query = `SELECT pos_complete_sale_v3($1,$2,'combined',$3::jsonb,'[{"provider":"cash","amount":26.03}]',$4,NULL,'{"type":"amount","value":1,"reason":"test"}','{}',NULL,30) AS result`;
  await assert.rejects(db.query(query,args),/discount authorization/);
  await db.query("INSERT INTO user_roles VALUES ($1,'store_manager')",[id(5)]);
  const result = (await db.query(query,args)).rows[0].result;
  const order = (await db.query("SELECT * FROM commerce_orders WHERE id=$1",[result.order_id])).rows[0];
  const item = (await db.query("SELECT * FROM commerce_order_items WHERE order_id=$1",[result.order_id])).rows[0];
  const receipt = (await db.query("SELECT payload FROM pos_receipts WHERE order_id=$1",[result.order_id])).rows[0].payload;
  assert.equal(Number(order.discount_total),4);
  assert.equal(Number(order.total_amount),26.03);
  assert.equal(Number(item.original_unit_price),10.01);
  assert.equal(Number(item.discount_total),4);
  assert.equal(Number(item.line_total),26.03);
  assert.equal(Number(result.items[0].line_total),26.03);
  assert.equal(Number(receipt.items[0].line_total),26.03);
  assert.equal(Number(receipt.total_amount),26.03);
  assert.equal(Number((await refund(result.order_id,item.id,"combined-refund",3)).refund_total),26.03);
  await db.exec("DELETE FROM user_roles");
});
test("sequential competing purchases cannot spend the same wallet balance", async () => {
  // PGlite serializes one connection; real multi-session locking needs the external PG harness.
  await db.exec("UPDATE pos_customer_wallets SET points=30");
  await sale("wallet-winner");
  await assert.rejects(sale("wallet-loser"), /points_balance_or_unit_invalid/);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,0);
});
test("completed refunds remain counted after later status changes", async () => {
  await db.exec("UPDATE pos_customer_wallets SET points=1000");
  const order = await sale("refund-status");
  const item = (await db.query("SELECT id FROM commerce_order_items WHERE order_id=$1",[order.order_id])).rows[0].id;
  const returned = await refund(order.order_id,item,"refund-status-first",3);
  await db.query("UPDATE pos_returns SET status='refunded' WHERE id=$1",[returned.return_id]);
  await assert.rejects(refund(order.order_id,item,"refund-status-again",1),/quantity exceeds/);
  assert.equal((await db.query("SELECT points FROM pos_customer_wallets")).rows[0].points,1000);
});
test("expired entitlements do not retain a paid-plan redemption cap", async () => {
  await db.exec(`UPDATE commerce_membership_plans SET points_redemption_cap_rate=0;
    INSERT INTO commerce_membership_plans(id,code,tier_code,points_redemption_cap_rate,points_redemption_enabled,
      points_redemption_points_per_unit,points_redemption_unit_fen)
    VALUES ('${id(20)}','explorer_monthly','explorer',0.15,true,10,100);
    INSERT INTO commerce_membership_entitlements(customer_id,plan_id,starts_at,expires_at)
    VALUES ('${id(2)}','${id(20)}',now()-interval '2 days',now()-interval '1 day');`);
  const rules = (await db.query("SELECT pos_points_rules($1) r",[id(2)])).rows[0].r;
  assert.equal(rules.cap_rate,0);
  await assert.rejects(sale("expired-membership"),/points_cap_exceeded/);
  await db.exec("UPDATE commerce_membership_entitlements SET expires_at=now()+interval '1 day'");
  assert.equal((await db.query("SELECT pos_points_rules($1) r",[id(2)])).rows[0].r.cap_rate,0.15);
  await db.exec("DELETE FROM commerce_membership_entitlements; UPDATE commerce_membership_plans SET points_redemption_cap_rate=0.15 WHERE code='free'");
});
test("cashier can use valid manager approval, but expired and wrong-location approvals fail", async () => {
  await db.query("INSERT INTO user_roles VALUES ($1,'store_manager')",[id(21)]);
  await db.exec(`INSERT INTO inv_locations VALUES ('${id(22)}');
    INSERT INTO pos_authorizations(id,location_id,operator_id,authorizer_id,action,status,expires_at)
    VALUES ('${id(23)}','${id(22)}','${id(5)}','${id(21)}','order_discount','approved',now()+interval '1 day');`);
  const query = `SELECT pos_complete_sale_v3($1,$2,'approved-combined',$3::jsonb,'[{"provider":"cash","amount":26.03}]',$4,NULL,'{"type":"amount","value":1,"reason":"test"}','{}',$5,30) result`;
  const args = [id(4),id(5),JSON.stringify([{sku_id:id(6),quantity:3}]),id(2),id(23)];
  await assert.rejects(db.query(query,args),/discount authorization/);
  await db.query("UPDATE pos_authorizations SET location_id=$1,expires_at=now()-interval '1 minute' WHERE id=$2",[id(1),id(23)]);
  await assert.rejects(db.query(query,args),/discount authorization/);
  await db.query("UPDATE pos_authorizations SET expires_at=now()+interval '1 minute' WHERE id=$1",[id(23)]);
  const result = (await db.query(query,args)).rows[0].result;
  assert.equal(Number(result.total_amount),26.03);
  const item = (await db.query("SELECT id FROM commerce_order_items WHERE order_id=$1",[result.order_id])).rows[0].id;
  await refund(result.order_id,item,"approved-refund",3);
  await db.exec("DELETE FROM user_roles");
});
test("return preview equals the real refund RPC across previously refunded quantities", async () => {
  await db.exec("UPDATE commerce_membership_plans SET points_redemption_points_per_unit=5 WHERE code='free'");
  const order = await sale("preview-parity",5,29.03);
  const items = (await db.query("SELECT * FROM commerce_order_items WHERE order_id=$1",[order.order_id])).rows;
  const requests = [{order_item_id:items[0].id,quantity:1}];
  const history = async () => (await db.query(`SELECT ri.order_item_id,ri.quantity,
    jsonb_build_object('status',r.status,'completed_at',r.completed_at) AS sale_return
    FROM pos_return_items ri JOIN pos_returns r ON r.id=ri.return_id WHERE r.order_id=$1`,[order.order_id])).rows;
  const amounts = [];
  const points = [];
  for (let i=0;i<3;i++) {
    const preview = calculatePointsReturnPreview(true,requests,items,await history());
    const result = await refund(order.order_id,items[0].id,`preview-parity-${i}`);
    assert.equal(preview.refund_total,Number(result.refund_total));
    assert.equal(preview.points_restored,result.points_restored);
    amounts.push(preview.refund_total);
    points.push(preview.points_restored);
    await db.query("UPDATE pos_returns SET status='refunded' WHERE id=$1",[result.return_id]);
  }
  assert.deepEqual(amounts,[9.67,9.68,9.68]);
  assert.deepEqual(points,[1,2,2]);
  const completedHistory = await history();
  assert.throws(() => calculatePointsReturnPreview(true,requests,items,completedHistory),/invalid_return_quantity/);
  await assert.rejects(refund(order.order_id,items[0].id,"preview-parity-over"),/quantity exceeds/);
});
