import { strict as assert } from "node:assert";
import { test } from "node:test";
import { aggregateSales, chooseDashboardScope, type CommerceSale } from "./sales-dashboard";

const order: CommerceSale = {
  id: "o1",
  order_no: "POS1",
  source_channel: "pos",
  paid_at: "2026-09-07T17:00:00Z",
  payment_status: "paid",
  order_status: "completed",
  currency: "CNY",
  total_amount: 30,
  items: [
    { id: "i1", location_id: "a", quantity: 2, line_total: 10 },
    { id: "i2", location_id: "b", quantity: 1, line_total: 20 },
  ],
  refunds: [],
};
const input = {
  range: { start: "2026-09-08", end: "2026-09-08" },
  locationIds: ["a", "b"],
  all: true,
  youzan: [],
  hasYouzan: false,
};
test("paid totals, units and successful refunds use cents", () => {
  const result = aggregateSales({
    ...input,
    commerce: [
      {
        ...order,
        refunds: [
          { amount: 3, status: "succeeded", after_sale: { order_item_id: "i1" } },
          { amount: 9, status: "failed", after_sale: null },
        ],
      },
    ],
  });
  assert.deepEqual(result.metrics, {
    netSalesFen: 2700,
    grossPaidFen: 3000,
    orders: 1,
    units: 3,
    aovFen: 2700,
  });
});
test("single-store amounts and refunds use their own order lines", () => {
  const result = aggregateSales({
    ...input,
    all: false,
    locationIds: ["a"],
    commerce: [
      {
        ...order,
        refunds: [{ amount: 3, status: "succeeded", after_sale: { order_item_id: "i2" } }],
      },
    ],
  });
  assert.equal(result.metrics.netSalesFen, 1000);
  assert.equal(result.metrics.units, 2);
});
test("unallocated partial refund on a split order is unknown for a store", () => {
  const result = aggregateSales({
    ...input,
    all: false,
    locationIds: ["a"],
    commerce: [{ ...order, refunds: [{ amount: 3, status: "succeeded", after_sale: null }] }],
  });
  assert.equal(result.metrics.netSalesFen, null);
  assert.ok(result.warnings.length);
});
test("unpaid and cancelled sales excluded, Shanghai dates and seven-day zero fill", () => {
  const result = aggregateSales({
    ...input,
    commerce: [
      order,
      { ...order, id: "o2", payment_status: "unpaid" },
      { ...order, id: "o3", order_status: "cancelled" },
    ],
  });
  assert.equal(result.metrics.orders, 1);
  assert.equal(result.trend.length, 7);
  assert.equal(result.trend.at(-1)?.grossPaidFen, 3000);
});
test("ERP Youzan mirror excluded and repeated channel rows deduplicated", () => {
  const yz = {
    tid: "T1",
    shop_id: "s1",
    pay_time: order.paid_at,
    status: "TRADE_SUCCESS",
    payment: 12.9,
    total_fee: 12.9,
    num: 1,
    outer_transaction_no: null,
  };
  const result = aggregateSales({
    ...input,
    hasYouzan: true,
    commerce: [{ ...order, source_channel: "youzan" }],
    youzan: [yz, yz],
  });
  assert.equal(result.metrics.orders, 1);
  assert.equal(result.metrics.grossPaidFen, 1290);
  assert.equal(result.metrics.netSalesFen, null);
});
test("exact external order correlation is counted once across POS and Youzan", () => {
  const yz = {
    tid: "T1",
    shop_id: "s1",
    pay_time: order.paid_at,
    status: "TRADE_SUCCESS",
    payment: 30,
    total_fee: 30,
    num: 3,
    outer_transaction_no: "POS1",
  };
  const result = aggregateSales({ ...input, commerce: [order], youzan: [yz], hasYouzan: true });
  assert.equal(result.metrics.orders, 1);
  assert.equal(result.metrics.grossPaidFen, 3000);
});
test("unavailable Youzan quantity never falls back to SKU count or one", () => {
  const result = aggregateSales({
    ...input,
    commerce: [],
    hasYouzan: true,
    youzan: [
      {
        tid: "T",
        shop_id: "s",
        pay_time: order.paid_at,
        status: "TRADE_SUCCESS",
        payment: 12.9,
        total_fee: 12.9,
        num: null,
        outer_transaction_no: null,
      },
    ],
  });
  assert.equal(result.metrics.units, null);
});
test("HQ can select all, staff defaults to first grant and cannot request all/other store", () => {
  assert.equal(chooseDashboardScope(true, ["a"], undefined), "all");
  assert.equal(chooseDashboardScope(false, ["a"], undefined), "a");
  assert.throws(() => chooseDashboardScope(false, ["a"], "all"));
  assert.throws(() => chooseDashboardScope(false, ["a"], "b"));
  assert.throws(() => chooseDashboardScope(false, [], undefined));
});
