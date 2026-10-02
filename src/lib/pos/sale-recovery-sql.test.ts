import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../../../", import.meta.url);
const db = new PGlite();
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
before(async () => {
  await db.exec(await readFile(new URL("tests/sql/pos-points-fixture.sql", root), "utf8"));
  await db.exec(
    await readFile(
      new URL("supabase/migrations/20260728120000_pos_member_discount_workflows.sql", root),
      "utf8",
    ),
  );
  const legacy = await readFile(
    new URL("supabase/migrations/20260803142151_f090c669-5831-41ec-aa6d-cc9f4a039f02.sql", root),
    "utf8",
  );
  await db.exec(
    legacy.slice(legacy.indexOf("CREATE OR REPLACE FUNCTION public.pos_complete_sale(")),
  );
  await db.exec(
    await readFile(
      new URL("supabase/migrations/20261002174301_pos_points_redemption.sql", root),
      "utf8",
    ),
  );
  await db.exec(`
    INSERT INTO inv_locations VALUES ('${id(1)}'),('${id(11)}');
    INSERT INTO commerce_customers VALUES ('${id(2)}','active');
    INSERT INTO pos_registers(id) VALUES ('${id(3)}');
    INSERT INTO pos_shifts(id,location_id,operator_id,register_id) VALUES
      ('${id(4)}','${id(1)}','${id(5)}','${id(3)}'),
      ('${id(14)}','${id(11)}','${id(5)}','${id(3)}');
    INSERT INTO inv_skus(id,price_tier) VALUES ('${id(6)}',10);
    INSERT INTO inv_stocks VALUES ('${id(6)}','${id(1)}',100);
    INSERT INTO pos_customer_wallets(customer_id,points) VALUES ('${id(2)}',1000);
    INSERT INTO commerce_membership_plans(code,tier_code,points_redemption_cap_rate,
      points_redemption_enabled,points_redemption_points_per_unit,points_redemption_unit_fen)
      VALUES ('free','free',0.1,true,10,100);
  `);
});
after(() => db.close());
async function recover(op: string, shift = id(4), operator = id(5)) {
  return (
    await db.query<{ result: any }>("SELECT pos_recover_sale_cancel($1,$2,$3) result", [
      shift,
      operator,
      op,
    ])
  ).rows[0].result;
}
async function sale(op: string, points = 0) {
  const args = [
    id(4),
    id(5),
    op,
    JSON.stringify([{ sku_id: id(6), quantity: 1 }]),
    JSON.stringify([{ provider: "cash", amount: points ? 9 : 10 }]),
    id(2),
  ];
  return (
    await db.query<{ result: any }>(
      points
        ? "SELECT pos_complete_sale_v3($1,$2,$3,$4::jsonb,$5::jsonb,$6,NULL,'{}','{}',NULL,10) result"
        : "SELECT pos_complete_sale_v2($1,$2,$3,$4::jsonb,$5::jsonb,$6) result",
      args,
    )
  ).rows[0].result;
}
test("cancel without an order permanently fences both late v2 and v3 requests", async () => {
  const cancelled = { status: "cancelled", client_op_id: "cancel-first", order: null };
  assert.deepEqual(await recover("cancel-first"), cancelled);
  assert.deepEqual(await recover("cancel-first"), cancelled);
  await assert.rejects(sale("cancel-first"), /sale_operation_cancelled/);
  await assert.rejects(sale("cancel-first", 10), /sale_operation_cancelled/);
  assert.equal(
    (await db.query<{ n: number }>("SELECT count(*)::int n FROM commerce_orders")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query<{ points: number }>("SELECT points FROM pos_customer_wallets")).rows[0].points,
    1000,
  );
  assert.equal((await db.query<{ qty: number }>("SELECT qty FROM inv_stocks")).rows[0].qty, 100);
});
test("completed zero-point and points sales return the original order, never a cancellation", async () => {
  for (const points of [0, 10]) {
    const op = `complete-first-${points}`;
    const order = await sale(op, points);
    const result = await recover(op);
    assert.equal(result.status, "completed");
    assert.equal(result.client_op_id, op);
    assert.equal(result.order.order_id, order.order_id);
    assert.equal(result.order.total_amount, points ? 9 : 10);
    assert.equal(result.order.points_redemption?.applied_points ?? 0, points);
    assert.deepEqual(await recover(op), result);
    assert.equal((await sale(op, points)).order_id, order.order_id);
  }
  assert.equal(
    (await db.query<{ points: number }>("SELECT points FROM pos_customer_wallets")).rows[0].points,
    990,
  );
  assert.equal(
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int n FROM pos_sale_cancellations WHERE client_op_id LIKE 'complete-first%'",
      )
    ).rows[0].n,
    0,
  );
});
test("employee and shift ownership are enforced for both cancellations and completed orders", async () => {
  await assert.rejects(recover("foreign-operator", id(4), id(99)), /shift_forbidden/);
  await assert.rejects(recover("cancel-first", id(14)), /idempotency_conflict/);
  await assert.rejects(recover("complete-first-0", id(14)), /idempotency_conflict/);
  await assert.rejects(recover("missing-shift", id(99)), /shift_not_found/);
});
test("closed original shifts can still be safely resolved", async () => {
  await db.exec(`UPDATE pos_shifts SET status='closed' WHERE id='${id(4)}'`);
  assert.equal((await recover("closed-shift-cancel")).status, "cancelled");
  assert.equal((await recover("complete-first-10")).status, "completed");
  await db.exec(`UPDATE pos_shifts SET status='open' WHERE id='${id(4)}'`);
  await assert.rejects(sale("closed-shift-cancel"), /sale_operation_cancelled/);
});
test("cancellation rollback does not leave a tombstone", async () => {
  await db.exec("BEGIN");
  await recover("rolled-back-cancel");
  await db.exec("ROLLBACK");
  assert.ok((await sale("rolled-back-cancel")).order_id);
});
test("stale-snapshot isolation cannot bypass the sale or recovery fence", async () => {
  for (const operation of [
    () => recover("isolation-recovery"),
    () => sale("isolation-zero"),
    () => sale("isolation-points", 10),
  ]) {
    await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await assert.rejects(operation(), /sale_recovery_isolation_unsupported/);
    } finally {
      await db.exec("ROLLBACK");
    }
  }
});
test("RPCs share the operation lock and runtime roles cannot bypass the cancellation fence", async () => {
  for (const fn of [
    "pos_recover_sale_cancel(uuid,uuid,text)",
    "pos_complete_sale_v3(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid,integer)",
  ]) {
    const definition = (
      await db.query<{ source: string }>("SELECT pg_get_functiondef($1::regprocedure) source", [fn])
    ).rows[0].source;
    assert.match(
      definition,
      /pg_advisory_xact_lock\(hashtextextended\('pos-sale:' \|\| p_client_op_id, 0\)\)/,
    );
  }
  for (const role of ["anon", "authenticated"]) {
    assert.equal(
      (
        await db.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1,'pos_recover_sale_cancel(uuid,uuid,text)','EXECUTE') allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
  }
  assert.equal(
    (
      await db.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('service_role','pos_complete_sale(uuid,uuid,text,jsonb,jsonb,uuid,text)','EXECUTE') allowed",
      )
    ).rows[0].allowed,
    false,
  );
  assert.equal(
    (
      await db.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('authenticated','pos_sale_cancellations','INSERT') allowed",
      )
    ).rows[0].allowed,
    false,
  );
  assert.equal(
    (
      await db.query<{ enabled: boolean }>(
        "SELECT relrowsecurity enabled FROM pg_class WHERE oid='pos_sale_cancellations'::regclass",
      )
    ).rows[0].enabled,
    true,
  );
});
