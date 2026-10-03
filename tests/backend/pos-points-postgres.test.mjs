import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import postgres from "postgres";

// Deliberately accepts no database URL. This test can only use a cluster it creates.
const bin = process.env.POS_TEST_PG_BIN;
assert.ok(bin, "Set POS_TEST_PG_BIN to a real PostgreSQL bin directory (postgres/initdb/pg_ctl)");
const root = new URL("../../", import.meta.url);
const migrationName = "supabase/migrations/20261002174301_pos_points_redemption.sql";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const evidence = { migration: migrationName, version: "", migration_sha256: "", races: [] };
let directory,
  started = false,
  admin,
  a,
  b,
  aPid,
  bPid;
const clients = [];
let productionBackup;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const load = (path) => readFile(new URL(path, root), "utf8");
const sqlFile = async (path) => admin.unsafe(await load(path));
function productionFunction(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, `missing production function ${name}`);
  const end = source.indexOf("\n$$;", start);
  assert.ok(end > start, `missing end of ${name}`);
  return source.slice(start, end + 4);
}
before(
  async () => {
    // A short private socket path also avoids macOS's Unix-domain path-length limit.
    directory = await mkdtemp("/tmp/pos-pg-test-");
    await mkdir(join(directory, "socket"), { mode: 0o700 });
    const data = join(directory, "data");
    execFileSync(
      join(bin, "initdb"),
      [
        "-D",
        data,
        "-U",
        "postgres",
        "--auth-local=trust",
        "--auth-host=reject",
        "--no-locale",
        "--encoding=UTF8",
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      join(bin, "pg_ctl"),
      [
        "-D",
        data,
        "-l",
        join(directory, "server.log"),
        "-w",
        "-t",
        "20",
        "-o",
        `-k ${join(directory, "socket")} -p 55432 -c listen_addresses='' -c max_connections=12 -c fsync=off`,
        "start",
      ],
      { stdio: "pipe" },
    );
    started = true;
    for (const name of ["audit-observer", "sale-a", "sale-b"]) {
      clients.push(
        postgres({
          host: join(directory, "socket"),
          port: 55432,
          username: "postgres",
          database: "postgres",
          max: 1,
          connect_timeout: 5,
          idle_timeout: 0,
          onnotice: () => {},
          connection: { application_name: name, statement_timeout: 10000 },
        }),
      );
    }
    [admin, a, b] = clients;
    evidence.version = (await admin`SELECT version() AS value`)[0].value;
    [aPid, bPid] = [
      (await a`SELECT pg_backend_pid() AS pid`)[0].pid,
      (await b`SELECT pg_backend_pid() AS pid`)[0].pid,
    ];
    assert.notEqual(aPid, bPid);
    assert.equal((await admin`SHOW listen_addresses`)[0].listen_addresses, "");
    await sqlFile("tests/sql/pos-points-fixture.sql");
    await sqlFile("tests/sql/pos-points-postgres-fixture.sql");
    await sqlFile("supabase/migrations/20260728120000_pos_member_discount_workflows.sql");
    const sale = await load(
      "supabase/migrations/20260803142151_f090c669-5831-41ec-aa6d-cc9f4a039f02.sql",
    );
    await admin.unsafe(
      sale.slice(sale.indexOf("CREATE OR REPLACE FUNCTION public.pos_complete_sale(")),
    );
    const inventory = await load(
      "supabase/migrations/20260804181500_handheld_custom_storefront_atomic_publish.sql",
    );
    await admin.unsafe(productionFunction(inventory, "sync_handheld_custom_listing"));
    await admin.unsafe(productionFunction(inventory, "inv_apply_movement"));
    await admin.unsafe(
      productionFunction(
        await load("supabase/migrations/20260803173000_vintage_standard_product_catalog.sql"),
        "sales_sku_available_qty",
      ),
    );
    productionBackup = JSON.parse(
      await load("tests/backend/pos-production-functions-before-20261003.json"),
    );
    assert.deepEqual(productionBackup.functions.map((f) => f.proname).sort(), [
      "pos_complete_return",
      "pos_complete_sale",
      "pos_complete_sale_v2",
    ]);
    evidence.production_baselines = [];
    for (const fn of productionBackup.functions) {
      const body = fn.definition.match(/\bAS\s+(\$[a-zA-Z_0-9]*\$)([\s\S]*?)\1/)[2];
      const [local] = await admin`SELECT prosrc,proacl::text AS acl FROM pg_proc
        WHERE pronamespace='public'::regnamespace AND proname=${fn.proname}`;
      assert.equal(local.prosrc, body, `${fn.proname}: production body drift`);
      assert.equal(local.acl, fn.acl, `${fn.proname}: production ACL drift`);
      // The cluster is disposable: retain public schema/search_path and load the
      // captured production definition verbatim, without rewriting its SQL.
      await admin.unsafe(fn.definition);
      evidence.production_baselines.push({
        name: fn.proname,
        body_md5: createHash("md5").update(body).digest("hex"),
        acl: fn.acl,
      });
    }
    const preflight = (await sqlFile("tests/backend/pos-points-preflight.sql"))[0]
      .pos_points_preflight;
    assert.deepEqual(preflight.missing_required_columns, []);
    assert.deepEqual(preflight.missing_required_functions, []);
    assert.ok(preflight.new_function_presence.every((fn) => !fn.present));
    assert.equal(preflight.new_table_present, false);
    const live = JSON.parse(await load("tests/backend/pos-production-preflight-20261003.json"))
      .rows[0].pos_points_preflight;
    assert.deepEqual(live.missing_required_functions, []);
    assert.deepEqual(live.missing_required_columns, []);
    assert.equal(live.default_transaction_isolation, "read committed");
    assert.equal(live.query_transaction_isolation, "read committed");
    assert.equal(live.isolation_overrides, null);
    assert.ok(live.constraints.every((c) => c.validated));
    assert.ok(live.indexes.every((i) => i.valid));
    for (const local of preflight.functions) {
      const actual = live.functions.find(
        (f) => f.name === local.name && f.identity_arguments === local.identity_arguments,
      );
      assert.ok(actual, `${local.name}: missing exact production signature`);
      assert.equal(
        actual.body_md5,
        local.body_md5,
        `${local.name}: production dependency body drift`,
      );
    }
    evidence.production_dependencies = {
      captured_at: live.captured_at,
      matched_function_bodies: preflight.functions.length,
      validated_constraints: live.constraints.length,
      valid_indexes: live.indexes.length,
      trigger_bodies_verified: true,
    };
    await sqlFile("tests/sql/pos-points-postgres-triggers-fixture.sql");
    const triggers = JSON.parse(
      await load("tests/backend/pos-production-triggers-20261003.json"),
    ).rows;
    for (const fn of triggers) {
      await admin.unsafe(fn.definition);
      assert.match(fn.proname, /^[a-z_]+$/);
      const signature = `public.${fn.proname}()`;
      await admin.unsafe(
        `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,anon,authenticated,service_role`,
      );
      await admin.unsafe(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`);
      if (fn.acl.includes("=X/postgres,postgres=")) {
        await admin.unsafe(`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC,anon,authenticated`);
      }
      const [loaded] = await admin`SELECT md5(prosrc) AS md5,
        proacl @> ${fn.acl}::text::aclitem[] AND proacl <@ ${fn.acl}::text::aclitem[] AS acl_matches FROM pg_proc
        WHERE oid=${signature}::regprocedure`;
      assert.equal(loaded.md5, fn.body_md5);
      assert.equal(loaded.acl_matches, true);
    }
    const attached = live.triggers.filter((t) => t.table !== "inv_locations");
    for (const trigger of attached) await admin.unsafe(trigger.definition);
    evidence.production_triggers = {
      loaded_bodies: triggers.length,
      attachments: attached.length,
      excluded: "inv_locations setup triggers; POS RPCs do not write locations",
    };
    await sqlFile("tests/backend/pos-points-function-definitions-readonly.sql");
    await sqlFile("tests/backend/pos-points-trigger-functions-readonly.sql");
    await sqlFile("tests/backend/pos-points-rules-readonly.sql");
    const migration = await load(migrationName);
    evidence.migration_sha256 = createHash("sha256").update(migration).digest("hex");
    await admin.unsafe(migration);
    const postflight = (await sqlFile("tests/backend/pos-points-preflight.sql"))[0]
      .pos_points_preflight;
    assert.ok(postflight.new_function_presence.every((fn) => fn.present));
    assert.equal(postflight.new_table_present, true);
    evidence.preflight_sql_verified = true;
    // Exercise service_role permissions and SECURITY DEFINER nesting, not owner bypass.
    await a`SET ROLE service_role`;
    await b`SET ROLE service_role`;
    console.log(
      `Isolated PostgreSQL: ${evidence.version}; backend PIDs ${aPid}/${bPid}; ${directory}`,
    );
  },
  { timeout: 60000 },
);

beforeEach(async () => {
  await a`ROLLBACK`;
  await b`ROLLBACK`;
  const tables = await admin`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  await admin.unsafe(`TRUNCATE ${tables.map((r) => `public."${r.tablename}"`).join(",")} CASCADE`);
  await admin.unsafe(`
    INSERT INTO inv_locations(id,shop_id) VALUES ('${id(1)}','${id(21)}');
    INSERT INTO commerce_customers VALUES ('${id(2)}','active');
    INSERT INTO pos_registers(id) VALUES ('${id(3)}');
    INSERT INTO pos_shifts(id,location_id,operator_id,register_id) VALUES
      ('${id(4)}','${id(1)}','${id(5)}','${id(3)}'),('${id(14)}','${id(1)}','${id(15)}','${id(3)}');
    INSERT INTO inv_skus(id,price_tier,barcode) VALUES ('${id(6)}',10.01,'TEST-6'),('${id(16)}',10.01,'TEST-16');
    INSERT INTO inv_stocks(sku_id,location_id,qty) VALUES ('${id(6)}','${id(1)}',100),('${id(16)}','${id(1)}',100);
    INSERT INTO pos_customer_wallets(customer_id,points) VALUES ('${id(2)}',5);
    INSERT INTO commerce_membership_plans(id,code,tier_code,points_redemption_cap_rate)
      VALUES ('${id(7)}','free','free',0);
  `);
});
after(async () => {
  for (const client of clients) {
    await client.unsafe("ROLLBACK").catch(() => {});
    await client.end({ timeout: 2 });
  }
  if (started)
    execFileSync(join(bin, "pg_ctl"), ["-D", join(directory, "data"), "-m", "fast", "-w", "stop"], {
      stdio: "pipe",
    });
  if (directory) {
    await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(
      `Stopped isolated cluster; retained synthetic fixture/log/evidence at ${directory}`,
    );
  }
});
async function enable() {
  // Synthetic test-only conversion. This is not a business-approved rate.
  await admin`UPDATE commerce_membership_plans SET points_redemption_enabled=true,points_redemption_points_per_unit=5,points_redemption_unit_fen=100,points_redemption_cap_rate=0.15`;
}
async function sale(client, op, { points = 5, shift = id(4), operator = id(5), sku = id(6) } = {}) {
  const args = [
    shift,
    operator,
    op,
    JSON.stringify([{ sku_id: sku, quantity: 3 }]),
    JSON.stringify([{ provider: "cash", amount: points ? 29.03 : 30.03 }]),
    id(2),
  ];
  const query = points
    ? "SELECT pos_complete_sale_v3($1,$2,$3,$4::text::jsonb,$5::text::jsonb,$6,NULL,'{}','{}',NULL,$7) result"
    : "SELECT pos_complete_sale_v2($1,$2,$3,$4::text::jsonb,$5::text::jsonb,$6) result";
  if (points) args.push(points);
  return (await client.unsafe(query, args))[0].result;
}
async function cancel(client, op) {
  return (await client`SELECT pos_recover_sale_cancel(${id(4)},${id(5)},${op}) result`)[0].result;
}
async function refund(client, order, item, op, quantity, otherShift = false) {
  return (
    await client.unsafe(
      "SELECT pos_complete_return($1,$2,$3,$4,$5::text::jsonb,'concurrency test',NULL) result",
      [
        otherShift ? id(14) : id(4),
        otherShift ? id(15) : id(5),
        order,
        op,
        JSON.stringify([{ order_item_id: item, quantity }]),
      ],
    )
  )[0].result;
}
const balance = async () =>
  (await admin`SELECT points FROM pos_customer_wallets WHERE customer_id=${id(2)}`)[0].points;
const count = async (table) =>
  Number((await admin.unsafe(`SELECT count(*) AS n FROM ${table}`))[0].n);
const settle = (promise) =>
  promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
async function blocked(label, blocker = aPid, waiter = bPid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (
      await admin`SELECT pg_blocking_pids(${waiter}) AS blockers,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=${waiter}`
    )[0];
    if (row?.blockers.includes(blocker)) {
      const locks =
        await admin`SELECT locktype,mode,granted FROM pg_locks WHERE pid=${waiter} AND NOT granted`;
      evidence.races.push({ label, blocker, waiter, ...row, locks });
      console.log(
        `Observed blocking: ${label}: ${blocker} -> ${waiter} (${row.wait_event_type}/${row.wait_event})`,
      );
      return;
    }
    await delay(20);
  }
  throw new Error(`No real lock wait observed: ${label}`);
}
async function seedOrder() {
  await enable();
  const order = await sale(a, "seed-sale");
  const item = (
    await admin`SELECT id FROM commerce_order_items WHERE order_id=${order.order_id}`
  )[0].id;
  return { order: order.order_id, item };
}

test("disabled defaults preserve zero-point v2 sale/refund and safe cancellation", async () => {
  const rules = (await admin`SELECT pos_points_rules(${id(2)}) result`)[0].result;
  assert.equal(rules.enabled, false);
  assert.equal(rules.points_per_unit, null);
  assert.equal(rules.unit_fen, null);
  await assert.rejects(sale(a, "disabled-points"), /points_rule_not_configured/);
  const order = await sale(a, "legacy-zero", { points: 0 });
  const item = (
    await admin`SELECT id FROM commerce_order_items WHERE order_id=${order.order_id}`
  )[0].id;
  assert.equal(
    Number((await refund(a, order.order_id, item, "legacy-return", 3)).refund_total),
    30.03,
  );
  assert.equal(await balance(), 5);
  assert.equal(await count("commerce_points_ledger"), 0);
  assert.equal((await cancel(a, "disabled-cancel")).status, "cancelled");
  await assert.rejects(sale(b, "disabled-cancel", { points: 0 }), /sale_operation_cancelled/);
});
test("disabled-points refund preserves production coupon and stock enqueue trigger atomicity", async () => {
  const order = await sale(a, "trigger-sale", { points: 0 });
  const item = (
    await admin`SELECT id FROM commerce_order_items WHERE order_id=${order.order_id}`
  )[0].id;
  await admin`INSERT INTO pos_customer_coupons(customer_id,code,name,discount_type,value,status,reserved_order_id)
    VALUES (${id(2)},'TEST-RESERVED','test','amount',1,'reserved',${order.order_id}),
      (${id(2)},'TEST-UNRELATED','test','amount',1,'reserved',${id(999)})`;
  const state = async () => ({
    coupons: (await admin`SELECT status FROM pos_customer_coupons ORDER BY code`).map(
      (r) => r.status,
    ),
    stock: (await admin`SELECT target_stock FROM youzan_stock_sync_queue WHERE sku_id=${id(6)}`)[0]
      .target_stock,
    points: await balance(),
    returns: await count("pos_returns"),
  });
  const initial = await state();
  assert.deepEqual(initial, {
    coupons: ["reserved", "reserved"],
    stock: 97,
    points: 5,
    returns: 0,
  });
  await a`BEGIN`;
  await refund(a, order.order_id, item, "trigger-refund", 3);
  await a`ROLLBACK`;
  assert.deepEqual(await state(), initial);
  await refund(a, order.order_id, item, "trigger-refund", 3);
  assert.deepEqual(await state(), {
    coupons: ["used", "reserved"],
    stock: 100,
    points: 5,
    returns: 1,
  });
  await refund(b, order.order_id, item, "trigger-refund", 3);
  assert.equal(await count("pos_returns"), 1);
  assert.equal(await count("youzan_stock_sync_queue"), 1);
  assert.equal(await count("commerce_points_ledger"), 0);
});
test("different shifts/SKUs cannot concurrently overspend one wallet", async () => {
  await enable();
  await a`BEGIN`;
  await sale(a, "wallet-winner");
  const second = settle(sale(b, "wallet-loser", { shift: id(14), operator: id(15), sku: id(16) }));
  await blocked("wallet-overspend");
  await a`COMMIT`;
  const result = await second;
  assert.equal(result.ok, false);
  assert.match(result.error.message, /points_balance_or_unit_invalid/);
  assert.equal(await balance(), 0);
  assert.equal(await count("commerce_orders"), 1);
  assert.equal(await count("commerce_points_ledger"), 1);
  assert.equal(await count("inv_stock_movements"), 1);
});
test("a rolled-back wallet debit lets the waiting sale proceed without a lost balance", async () => {
  await enable();
  await a`BEGIN`;
  await sale(a, "wallet-rollback");
  const second = settle(
    sale(b, "wallet-after-rollback", { shift: id(14), operator: id(15), sku: id(16) }),
  );
  await blocked("wallet-rollback");
  await a`ROLLBACK`;
  assert.equal((await second).ok, true);
  assert.equal(await balance(), 0);
  assert.equal(await count("commerce_orders"), 1);
  assert.equal(await count("commerce_payments"), 1);
  assert.equal(await count("commerce_points_ledger"), 1);
});
for (const points of [0, 5])
  test(`same-op concurrent sale (${points} points) replays once`, async () => {
    await enable();
    await a`BEGIN`;
    const first = await sale(a, "same-op", { points });
    const second = settle(sale(b, "same-op", { points }));
    await blocked(`same-op-${points}`);
    await a`COMMIT`;
    const result = await second;
    assert.equal(result.ok, true);
    assert.equal(result.value.order_id, first.order_id);
    assert.equal(result.value.replayed, true);
    assert.equal(await count("commerce_orders"), 1);
    assert.equal(await count("commerce_points_ledger"), points ? 1 : 0);
    assert.equal(await count("inv_stock_movements"), 1);
    assert.equal(await balance(), 5 - points);
  });
for (const points of [0, 5])
  test(`cancel wins against a late sale (${points} points)`, async () => {
    await enable();
    await a`BEGIN`;
    assert.equal((await cancel(a, "cancel-first")).status, "cancelled");
    const second = settle(sale(b, "cancel-first", { points }));
    await blocked(`cancel-first-${points}`);
    await a`COMMIT`;
    const result = await second;
    assert.equal(result.ok, false);
    assert.match(result.error.message, /sale_operation_cancelled/);
    assert.equal((await cancel(b, "cancel-first")).status, "cancelled");
    assert.equal(await count("commerce_orders"), 0);
    assert.equal(await count("commerce_points_ledger"), 0);
    assert.equal(await count("inv_stock_movements"), 0);
    assert.equal(await balance(), 5);
  });
test("cash completion wins against cancellation and returns the original order", async () => {
  await a`BEGIN`;
  const first = await sale(a, "cash-first", { points: 0 });
  const second = settle(cancel(b, "cash-first"));
  await blocked("cash-first-cancel");
  await a`COMMIT`;
  const result = await second;
  assert.equal(result.ok, true);
  assert.equal(result.value.status, "completed");
  assert.equal(result.value.order.order_id, first.order_id);
  assert.equal(await count("pos_sale_cancellations"), 0);
  assert.equal(await count("commerce_orders"), 1);
});
test("rollback of cancellation allows the waiting cash sale", async () => {
  await a`BEGIN`;
  await cancel(a, "cancel-rollback");
  const second = settle(sale(b, "cancel-rollback", { points: 0 }));
  await blocked("cancel-rollback");
  await a`ROLLBACK`;
  assert.equal((await second).ok, true);
  assert.equal(await count("pos_sale_cancellations"), 0);
  assert.equal(await count("commerce_orders"), 1);
});
test("concurrent duplicate refunds restore points only once", async () => {
  const { order, item } = await seedOrder();
  await a`BEGIN`;
  const first = await refund(a, order, item, "same-return", 1);
  const second = settle(refund(b, order, item, "same-return", 1));
  await blocked("refund-same-op");
  await a`COMMIT`;
  const result = await second;
  assert.equal(result.ok, true);
  assert.equal(result.value.return_id, first.return_id);
  assert.equal(result.value.points_restored, 1);
  assert.equal(await balance(), 1);
  assert.equal(await count("pos_returns"), 1);
  assert.equal(await count("commerce_points_ledger"), 2);
});
test("different-shift split refunds conserve every fen/point including refunded status", async () => {
  const { order, item } = await seedOrder();
  await a`BEGIN`;
  const first = await refund(a, order, item, "split-first", 1);
  // Use the owner only to simulate a later administrative status change in the same transaction.
  await a`SET LOCAL ROLE postgres`;
  await a`UPDATE pos_returns SET status='refunded' WHERE id=${first.return_id}`;
  await a`SET LOCAL ROLE service_role`;
  const second = settle(refund(b, order, item, "split-rest", 2, true));
  await blocked("refund-split-order-lock");
  await a`COMMIT`;
  const result = await second;
  assert.equal(result.ok, true);
  assert.equal(Number(first.refund_total), 9.67);
  assert.equal(Number(result.value.refund_total), 19.36);
  assert.equal(first.points_restored + result.value.points_restored, 5);
  assert.equal(await balance(), 5);
  assert.equal((await admin`SELECT qty FROM inv_stocks WHERE sku_id=${id(6)}`)[0].qty, 100);
});
test("concurrent excess refunds fail and roll back even after prior status becomes refunded", async () => {
  const { order, item } = await seedOrder();
  await a`BEGIN`;
  const first = await refund(a, order, item, "over-first", 2);
  await a`SET LOCAL ROLE postgres`;
  await a`UPDATE pos_returns SET status='refunded' WHERE id=${first.return_id}`;
  await a`SET LOCAL ROLE service_role`;
  const second = settle(refund(b, order, item, "over-second", 2, true));
  await blocked("refund-over-quantity");
  await a`COMMIT`;
  const result = await second;
  assert.equal(result.ok, false);
  assert.match(result.error.message, /quantity exceeds/);
  assert.equal(await balance(), 3);
  assert.equal(await count("pos_returns"), 1);
  assert.equal(await count("commerce_points_ledger"), 2);
  assert.equal((await admin`SELECT qty FROM inv_stocks WHERE sku_id=${id(6)}`)[0].qty, 99);
});
test("refund credit and another sale serialize on the same wallet", async () => {
  const { order, item } = await seedOrder();
  await a`BEGIN`;
  await refund(a, order, item, "wallet-refund", 3);
  const second = settle(
    sale(b, "spend-restored", { shift: id(14), operator: id(15), sku: id(16) }),
  );
  await blocked("refund-versus-new-sale");
  await a`COMMIT`;
  assert.equal((await second).ok, true);
  assert.equal(await balance(), 0);
  assert.equal(await count("commerce_orders"), 2);
  assert.equal(await count("pos_returns"), 1);
  assert.equal(await count("commerce_points_ledger"), 3);
});

test("a cross-version same-op replay cannot rewrite a points sale as zero points", async () => {
  await enable();
  await a`BEGIN`;
  await sale(a, "cross-version");
  const second = settle(sale(b, "cross-version", { points: 0 }));
  await blocked("same-op-v3-versus-v2");
  await a`COMMIT`;
  const result = await second;
  assert.equal(result.ok, false);
  assert.match(result.error.message, /idempotency_conflict/);
  assert.equal(await balance(), 0);
  assert.equal(await count("commerce_orders"), 1);
  assert.equal(await count("commerce_points_ledger"), 1);
});
test("deployment counterexample: cancel RPC alone cannot fence an unmodified legacy v2", async () => {
  const signature =
    "public.pos_complete_sale_v2(uuid,uuid,text,jsonb,jsonb,uuid,text,jsonb,jsonb,uuid)";
  const wrapped = (await admin`SELECT pg_get_functiondef(${signature}::regprocedure) AS source`)[0]
    .source;
  const legacy = productionBackup.functions.find(
    (fn) => fn.proname === "pos_complete_sale_v2",
  ).definition;
  try {
    // Test-only simulation of deploying the cancellation RPC without the sale fence.
    await admin.unsafe(legacy);
    assert.equal((await cancel(a, "unsafe-partial-deploy")).status, "cancelled");
    const late = await sale(b, "unsafe-partial-deploy", { points: 0 });
    assert.ok(
      late.order_id,
      "The unchanged legacy v2 ignores cancellation: partial deployment is unsafe",
    );
    evidence.partial_deployment_counterexample = { cancelled: true, late_sale_created: true };
  } finally {
    await admin.unsafe(wrapped);
  }
});
