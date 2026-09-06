import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import {
  FULFILLMENT_WORKFLOW_VERSION,
  computePickGuard,
  evaluateFulfillmentAccess,
  type PickGuardInput,
} from "./handheld-fulfillment-access.server";

const STORE_A = "11111111-1111-4111-8111-111111111111";
const STORE_B = "22222222-2222-4222-8222-222222222222";

describe("workflow_version 契约", () => {
  it("必须是数字 1，不能是字符串", () => {
    assert.equal(typeof FULFILLMENT_WORKFLOW_VERSION, "number");
    assert.equal(FULFILLMENT_WORKFLOW_VERSION, 1);
  });
});

describe("evaluateFulfillmentAccess", () => {
  const base = {
    mode: "write" as const,
    isHq: false,
    deviceLocationId: STORE_A,
    fulfillmentLocationId: STORE_A,
    userAllowedAtFulfillmentLocation: true,
    orderStatus: "processing" as string | null,
  };

  it("普通员工在设备当前库位可写，scope 为该库位", () => {
    const r = evaluateFulfillmentAccess(base);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.scope, `location:${STORE_A}`);
  });

  it("普通员工访问其它门店子单 403", () => {
    const r = evaluateFulfillmentAccess({ ...base, fulfillmentLocationId: STORE_B });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.status, 403);
    assert.equal(r.ok === false && r.code, "location_forbidden");
  });

  it("HQ 不依赖设备绑定库位，可操作目标子单所在门店", () => {
    const r = evaluateFulfillmentAccess({
      ...base,
      isHq: true,
      deviceLocationId: STORE_A,
      fulfillmentLocationId: STORE_B,
    });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.scope, `location:${STORE_B}`);
  });

  it("HQ 对目标库位无授权时仍 403", () => {
    const r = evaluateFulfillmentAccess({
      ...base,
      isHq: true,
      fulfillmentLocationId: STORE_B,
      userAllowedAtFulfillmentLocation: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, "location_forbidden");
  });

  for (const status of ["cancelled", "closed"]) {
    it(`父订单 ${status} 时禁止写，读仍允许`, () => {
      const w = evaluateFulfillmentAccess({ ...base, isHq: true, orderStatus: status });
      assert.equal(w.ok, false);
      assert.equal(w.ok === false && w.code, "order_cancelled");
      assert.equal(w.ok === false && w.status, 409);
      const r = evaluateFulfillmentAccess({ ...base, mode: "read", orderStatus: status });
      assert.equal(r.ok, true);
    });
  }
});

describe("computePickGuard（服务端真实判定）", () => {
  const items = [
    { id: "i1", expected_qty: 1, picked_qty: 1 },
    { id: "i2", expected_qty: 2, picked_qty: 2 },
  ];

  it("全部拣完且无缺货 → 可完成", () => {
    const g = computePickGuard({
      fulfillmentStatus: "picking",
      orderCancelled: false,
      items,
      shortages: [],
    });
    assert.equal(g.can_complete_pick, true);
    assert.deepEqual(g.blocked_reasons, []);
  });

  it("pending_customer 缺货阻止完成", () => {
    const g = computePickGuard({
      fulfillmentStatus: "picking",
      orderCancelled: false,
      items,
      shortages: [
        {
          fulfillment_item_id: "i2",
          quantity: 1,
          status: "pending_customer",
          refund_state: "not_required",
        },
      ],
    });
    assert.equal(g.can_complete_pick, false);
    assert.ok(g.blocked_reasons.includes("shortage_pending_customer"));
    assert.equal(g.pending_customer_count, 1);
  });

  it("refund_pending 阻止完成", () => {
    const g = computePickGuard({
      fulfillmentStatus: "picking",
      orderCancelled: false,
      items,
      shortages: [
        {
          fulfillment_item_id: "i2",
          quantity: 1,
          status: "customer_accepted",
          refund_state: "refund_pending",
        },
      ],
    });
    assert.equal(g.can_complete_pick, false);
    assert.ok(g.blocked_reasons.includes("refund_pending"));
    assert.equal(g.refund_pending_count, 1);
  });

  it("有未拣完行阻止完成", () => {
    const g = computePickGuard({
      fulfillmentStatus: "picking",
      orderCancelled: false,
      items: [{ id: "i1", expected_qty: 2, picked_qty: 1 }],
      shortages: [],
    });
    assert.equal(g.can_complete_pick, false);
    assert.ok(g.blocked_reasons.includes("lines_unpicked"));
    assert.equal(g.unpicked_line_count, 1);
  });

  it("父订单取消阻止完成", () => {
    const g = computePickGuard({
      fulfillmentStatus: "picking",
      orderCancelled: true,
      items,
      shortages: [],
    });
    assert.equal(g.can_complete_pick, false);
    assert.ok(g.blocked_reasons.includes("order_cancelled"));
  });

  it("已交接等非拣货状态不可再次完成", () => {
    const g = computePickGuard({
      fulfillmentStatus: "handed_over",
      orderCancelled: false,
      items,
      shortages: [],
    });
    assert.equal(g.can_complete_pick, false);
    assert.ok(g.blocked_reasons.includes("status_handed_over"));
  });
});

describe("pick guard safety regressions", () => {
  const base: PickGuardInput = {
    fulfillmentStatus: "picking",
    orderCancelled: false,
    items: [{ id: "i1", expected_qty: 3, picked_qty: 3 }],
    shortages: [],
  };
  const accepted = {
    fulfillment_item_id: "i1",
    quantity: 1,
    status: "customer_accepted",
    refund_state: "refund_completed",
  };

  it("blocks an empty item result", () => {
    const guard = computePickGuard({ ...base, items: [] });
    assert.equal(guard.can_complete_pick, false);
    assert.ok(guard.blocked_reasons.includes("items_empty"));
  });

  for (const query of ["items", "shortages"] as const) {
    it(`fails closed on a real ${query} query error even with returned rows`, () => {
      const error = { code: "42501", message: "permission denied", details: null, hint: null };
      const guard = computePickGuard({
        ...base,
        itemQueryError: query === "items" ? error : null,
        shortageQueryError: query === "shortages" ? error : null,
      });
      assert.equal(guard.can_complete_pick, false);
      assert.ok(guard.blocked_reasons.includes(`${query}_load_failed`));
    });

    it(`fails closed on missing ${query} data without an error`, () => {
      const guard = computePickGuard({ ...base, [query]: null });
      assert.equal(guard.can_complete_pick, false);
      assert.ok(guard.blocked_reasons.includes(`${query}_load_failed`));
    });
  }

  for (const refund_state of ["refund_completed", "not_required"]) {
    for (const picked_qty of [0, 1, 2]) {
      it(`${refund_state}: a one-unit shortage still requires two of three units (picked ${picked_qty})`, () => {
        const guard = computePickGuard({
          ...base,
          items: [{ id: "i1", expected_qty: 3, picked_qty }],
          shortages: [{ ...accepted, refund_state }],
        });
        assert.equal(guard.can_complete_pick, picked_qty === 2);
        assert.equal(guard.unpicked_line_count, picked_qty === 2 ? 0 : 1);
      });
    }

    it(`${refund_state}: a fully approved shortage can cover the full quantity`, () => {
      const guard = computePickGuard({
        ...base,
        items: [{ id: "i1", expected_qty: 3, picked_qty: 0 }],
        shortages: [{ ...accepted, quantity: 3, refund_state }],
      });
      assert.equal(guard.can_complete_pick, true);
    });
  }

  for (const refund_state of ["refund_pending", null, "refunded"]) {
    it(`does not discount accepted quantities with uncleared refund state ${refund_state}`, () => {
      const guard = computePickGuard({
        ...base,
        items: [{ id: "i1", expected_qty: 3, picked_qty: 2 }],
        shortages: [{ ...accepted, refund_state }],
      });
      assert.equal(guard.can_complete_pick, false);
      assert.equal(guard.unpicked_line_count, 1);
    });
  }

  it("sums only approved quantities for their own line", () => {
    const guard = computePickGuard({
      ...base,
      items: [
        { id: "i1", expected_qty: 3, picked_qty: 1 },
        { id: "i2", expected_qty: 2, picked_qty: 1 },
      ],
      shortages: [accepted, { ...accepted, refund_state: "not_required" }],
    });
    assert.equal(guard.can_complete_pick, false);
    assert.equal(guard.unpicked_line_count, 1);
  });

  for (const status of ["pending_customer", "customer_cancelled", "withdrawn"]) {
    it(`${status} does not reduce the required quantity even after a refund`, () => {
      const guard = computePickGuard({
        ...base,
        items: [{ id: "i1", expected_qty: 3, picked_qty: 2 }],
        shortages: [{ ...accepted, status }],
      });
      assert.equal(guard.can_complete_pick, false);
      assert.equal(guard.unpicked_line_count, 1);
    });
  }

  it("ignores a withdrawn shortage's stale refund_pending after all units are picked", () => {
    const guard = computePickGuard({
      ...base,
      shortages: [{ ...accepted, status: "withdrawn", refund_state: "refund_pending" }],
    });
    assert.equal(guard.can_complete_pick, true);
    assert.equal(guard.refund_pending_count, 0);
    assert.deepEqual(guard.blocked_reasons, []);
  });

  it("still blocks an active customer-cancelled shortage awaiting refund", () => {
    const guard = computePickGuard({
      ...base,
      shortages: [{ ...accepted, status: "customer_cancelled", refund_state: "refund_pending" }],
    });
    assert.equal(guard.can_complete_pick, false);
    assert.equal(guard.refund_pending_count, 1);
  });
});

// These are source-contract checks, not a substitute for PostgreSQL transaction tests.
describe("fulfillment_complete_pick safety migration (static)", () => {
  function migrationSql() {
    const directory = new URL("../../supabase/migrations/", import.meta.url);
    const files = readdirSync(directory).filter((name) =>
      /^\d{14}_fulfillment_complete_pick_safety\.sql$/.test(name),
    );
    assert.equal(files.length, 1, "one explicitly named additive safety migration is required");
    return readFileSync(new URL(files[0], directory), "utf8");
  }

  function functionSql(name: string) {
    const match = migrationSql().match(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]+?\\$\\$;`),
    );
    assert.ok(match, `missing function ${name}`);
    return match[0];
  }

  it("defines only completion and the insert guard and keeps backend-only execution", () => {
    const sql = migrationSql();
    assert.deepEqual(
      [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((match) => match[1]),
      ["fulfillment_complete_pick", "tg_fulfillment_shortage_insert_guard"],
    );
    assert.match(sql, /FUNCTION public\.fulfillment_complete_pick\(/);
    assert.match(sql, /RETURNS public\.fulfillments/);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.fulfillment_complete_pick\(uuid,uuid,uuid\) FROM PUBLIC, anon, authenticated/,
    );
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.fulfillment_complete_pick\(uuid,uuid,uuid\) TO service_role/,
    );
  });

  it("locks every participating row set before shortage and quantity checks", () => {
    const sql = functionSql("fulfillment_complete_pick");
    for (const table of [
      "fulfillments",
      "commerce_orders",
      "fulfillment_items",
      "fulfillment_shortages",
    ]) {
      assert.match(sql, new RegExp(`FROM public\\.${table}\\b[^;]+FOR UPDATE;`));
    }
    const lastLock = sql.lastIndexOf("FOR UPDATE;");
    assert.ok(lastLock < sql.indexOf("IF EXISTS"));
    assert.doesNotMatch(sql, /SKIP LOCKED/);
  });

  it("retains location, picking status and claimed-device checks and blocks cancelled parents", () => {
    const sql = functionSql("fulfillment_complete_pick");
    assert.match(sql, /id = p_fulfillment_id AND location_id = p_location_id FOR UPDATE/);
    assert.match(sql, /v_row\.status <> 'picking'/);
    assert.match(
      sql,
      /claimed_device_id IS NOT NULL[\s\S]+claimed_device_id IS DISTINCT FROM p_device_id/,
    );
    assert.match(sql, /v_order_status IN \('cancelled', 'closed'\)/);
    assert.match(sql, /IF NOT FOUND THEN[\s\S]+items_empty/);
  });

  it("blocks pending confirmation and active pending refunds", () => {
    const sql = functionSql("fulfillment_complete_pick");
    assert.match(sql, /status = 'pending_customer'/);
    assert.match(sql, /status <> 'withdrawn' AND refund_state = 'refund_pending'/);
    assert.match(sql, /RAISE EXCEPTION '[^']*shortage_pending_customer_confirmation'/);
    assert.match(sql, /RAISE EXCEPTION '[^']*refund_pending'/);
  });

  it("subtracts only summed, accepted and cleared quantities from the matching line", () => {
    const sql = functionSql("fulfillment_complete_pick");
    assert.match(sql, /fi\.picked_qty < greatest\(fi\.expected_qty::bigint - coalesce\(/);
    assert.match(sql, /SELECT sum\(s\.quantity\)/);
    assert.match(sql, /s\.fulfillment_id = p_fulfillment_id[\s\S]+s\.fulfillment_item_id = fi\.id/);
    assert.match(sql, /s\.status = 'customer_accepted'/);
    assert.match(sql, /s\.refund_state IN \('refund_completed', 'not_required'\)/);
    assert.doesNotMatch(sql, /'refunded'|AND NOT EXISTS/);
  });

  it("installs a row-level BEFORE INSERT guard without intercepting customer confirmation updates", () => {
    const sql = migrationSql();
    assert.match(
      sql,
      /CREATE TRIGGER trg_fulfillment_shortage_insert_guard\s+BEFORE INSERT ON public\.fulfillment_shortages\s+FOR EACH ROW EXECUTE FUNCTION public\.tg_fulfillment_shortage_insert_guard\(\);/,
    );
    assert.doesNotMatch(sql, /BEFORE INSERT OR UPDATE|BEFORE UPDATE|AFTER UPDATE/);
    const guard = functionSql("tg_fulfillment_shortage_insert_guard");
    assert.match(guard, /RETURNS trigger[\s\S]+VOLATILE[\s\S]+SECURITY INVOKER/);
    assert.match(guard, /RETURN NEW;/);
    assert.doesNotMatch(guard, /UPDATE public\.fulfillment_shortages|NEW\.status\s*:=/);
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.tg_fulfillment_shortage_insert_guard\(\) FROM PUBLIC, anon, authenticated/,
    );
  });

  it("uses the completion RPC lock order before reading the remaining shortage allowance", () => {
    const lockTables = (sql: string) =>
      [...sql.matchAll(/FROM public\.(\w+)\b[^;]+FOR UPDATE;/g)].map((match) => match[1]);
    const guard = functionSql("tg_fulfillment_shortage_insert_guard");
    assert.deepEqual(lockTables(guard), lockTables(functionSql("fulfillment_complete_pick")));
    assert.ok(
      guard.lastIndexOf("FOR UPDATE;") < guard.indexOf("SELECT coalesce(sum(s.quantity), 0)"),
    );
    assert.doesNotMatch(guard, /SKIP LOCKED|NOWAIT/);
  });

  it("checks the locked fulfillment is allocated or picking and its parent is present and writable", () => {
    const guard = functionSql("tg_fulfillment_shortage_insert_guard");
    assert.match(guard, /WHERE id = NEW\.fulfillment_id FOR UPDATE;/);
    assert.match(guard, /IF NOT FOUND THEN RAISE EXCEPTION 'shortage_fulfillment_not_found'/);
    assert.match(guard, /v_row\.status NOT IN \('allocated', 'picking'\)/);
    assert.match(guard, /RAISE EXCEPTION 'shortage_fulfillment_not_pickable'/);
    assert.match(guard, /WHERE id = v_row\.order_id FOR UPDATE;/);
    assert.match(guard, /IF NOT FOUND THEN RAISE EXCEPTION 'shortage_order_not_found'/);
    assert.match(guard, /v_order_status IN \('cancelled', 'closed'\)/);
    assert.match(guard, /RAISE EXCEPTION 'shortage_order_cancelled'/);
  });

  it("binds the shortage to a locked item and the fulfillment's actual parent", () => {
    const guard = functionSql("tg_fulfillment_shortage_insert_guard");
    assert.match(
      guard,
      /WHERE fi\.id = NEW\.fulfillment_item_id\s+AND fi\.fulfillment_id = v_row\.id FOR UPDATE;/,
    );
    assert.match(guard, /IF NOT FOUND THEN RAISE EXCEPTION 'shortage_line_mismatch'/);
    assert.match(guard, /NEW\.order_id IS NOT NULL AND NEW\.order_id <> v_row\.order_id/);
    assert.match(guard, /RAISE EXCEPTION 'shortage_order_mismatch'/);
    assert.match(guard, /NEW\.order_id := v_row\.order_id;/);
  });

  it("reserves only the same line's non-withdrawn quantities, so other pending lines and withdrawn re-reports remain possible", () => {
    const guard = functionSql("tg_fulfillment_shortage_insert_guard");
    assert.match(
      guard,
      /SELECT coalesce\(sum\(s\.quantity\), 0\) INTO v_reported_qty\s+FROM public\.fulfillment_shortages s\s+WHERE s\.fulfillment_id = v_row\.id\s+AND s\.fulfillment_item_id = v_item\.id\s+AND s\.status <> 'withdrawn';/,
    );
    assert.doesNotMatch(guard, /IF EXISTS|status = 'pending_customer'|refund_state\s*=/);
    assert.match(guard, /NEW\.quantity IS NULL OR NEW\.quantity <= 0/);
    assert.match(guard, /RAISE EXCEPTION 'shortage_invalid_quantity'/);
    assert.match(
      guard,
      /NEW\.quantity::bigint > v_item\.expected_qty::bigint - v_item\.picked_qty - v_reported_qty/,
    );
    assert.match(guard, /RAISE EXCEPTION 'shortage_quantity_exceeds_unpicked'/);
  });

  it("versions the locked fulfillment on a valid insertion so repeatable-read snapshots cannot admit duplicate allowance", () => {
    const guard = functionSql("tg_fulfillment_shortage_insert_guard");
    assert.match(
      guard,
      /UPDATE public\.fulfillments SET updated_at = now\(\)\s+WHERE id = v_row\.id;/,
    );
    assert.ok(
      guard.indexOf("UPDATE public.fulfillments") >
        guard.indexOf("shortage_quantity_exceeds_unpicked"),
    );
    assert.doesNotMatch(guard, /SET status =/);
  });
});
