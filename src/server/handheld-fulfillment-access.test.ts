import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  FULFILLMENT_WORKFLOW_VERSION,
  computePickGuard,
  evaluateFulfillmentAccess,
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
      shortages: [{ fulfillment_item_id: "i2", status: "pending_customer", refund_state: null }],
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
        { fulfillment_item_id: "i2", status: "customer_accepted", refund_state: "refund_pending" },
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

  it("客户已确认缺货的行不再要求拣满，但退款仍待处理时阻止", () => {
    const accepted = computePickGuard({
      fulfillmentStatus: "picking",
      orderCancelled: false,
      items: [{ id: "i1", expected_qty: 2, picked_qty: 0 }],
      shortages: [
        { fulfillment_item_id: "i1", status: "customer_accepted", refund_state: "refunded" },
      ],
    });
    assert.equal(accepted.can_complete_pick, true);
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
