import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compensateRecentYouzanSales, SALE_COMPENSATION_FLOOR, type CompensationDeps } from "./youzan-sale-compensation.server";

const NOW = new Date("2026-10-07T10:00:00Z");
const order = (tid: string, pay: string, over: Record<string, unknown> = {}) => ({
  tid, shop_id: "shop-xtd", status: "TRADE_SUCCESS", pay_time: pay,
  raw: { full_order_info: {
    order_info: { tid, status: "TRADE_SUCCESS", offline_id: 212291308, refund_state: 0, ...(over.order_info as object ?? {}) },
    source_info: { is_offline_order: true },
    orders: [{ oid: `${tid}-1`, item_id: 6480588312, sku_id: 0, outer_sku_id: "2002535897511", num: 1 }],
  } },
  ...over,
});

function deps(rows: ReturnType<typeof order>[], opts: { committed?: Record<string, number>; failTid?: string } = {}) {
  const commits: string[] = [];
  const seenSince: string[] = [];
  const d: CompensationDeps = {
    listOrders: async ({ since, limit }) => { seenSince.push(since); return rows.filter((r) => r.pay_time >= since).slice(0, limit); },
    committedUnits: async (tids) => Object.fromEntries(tids.map((t) => [t, opts.committed?.[t] ?? 0])),
    adapter: () => ({
      findLocationId: async () => "loc-xtd",
      findSkuId: async () => "sku-nara",
      commitSale: async (i) => {
        if (i.sourceOrderId.startsWith(opts.failTid ?? "~")) throw new Error("db timeout");
        commits.push(i.sourceOrderId); return { ok: true };
      },
    }),
  };
  return { d, commits, seenSince };
}

describe("bounded recent Youzan sale compensation", () => {
  test("only recent paid orders after the floor are considered; history imports never deduct", async () => {
    const { d, commits, seenSince } = deps([
      order("OLD", "2026-09-20T00:00:00Z"),
      order("RECENT", "2026-10-06T14:04:14Z"),
    ]);
    const r = await compensateRecentYouzanSales(d, { now: NOW, windowHours: 500 });
    assert.ok(seenSince[0] >= SALE_COMPENSATION_FLOOR);
    assert.ok(Date.parse(seenSince[0]) >= NOW.getTime() - 72 * 3600_000, "window clamped to 72h");
    assert.deepEqual(commits, ["RECENT#oid:RECENT-1#0"]);
    assert.equal(r.committed, 1);
  });
  test("refunded or closed orders are skipped (refund never auto-restocks or re-deducts)", async () => {
    const { d, commits } = deps([
      order("REF", "2026-10-06T10:00:00Z", { order_info: { refund_state: 2 } }),
      order("CLOSED", "2026-10-06T11:00:00Z", { status: "TRADE_CLOSED" }),
    ]);
    const r = await compensateRecentYouzanSales(d, { now: NOW });
    assert.deepEqual(commits, []);
    assert.equal(r.skipped, 2);
  });
  test("orders whose units already have sale events are skipped without RPC calls", async () => {
    const { d, commits } = deps([order("DONE", "2026-10-06T12:00:00Z")], { committed: { DONE: 1 } });
    const r = await compensateRecentYouzanSales(d, { now: NOW });
    assert.deepEqual(commits, []);
    assert.equal(r.already, 1);
  });
  test("a failing order is reported and retried next run without blocking others", async () => {
    const rows = [order("BAD", "2026-10-06T12:00:00Z"), order("GOOD", "2026-10-06T13:00:00Z")];
    const first = deps(rows, { failTid: "BAD" });
    const r1 = await compensateRecentYouzanSales(first.d, { now: NOW });
    assert.equal(r1.failed, 1);
    assert.deepEqual(first.commits, ["GOOD#oid:GOOD-1#0"]);
    const second = deps(rows, { committed: { GOOD: 1 } });
    const r2 = await compensateRecentYouzanSales(second.d, { now: NOW });
    assert.deepEqual(second.commits, ["BAD#oid:BAD-1#0"]);
    assert.equal(r2.committed, 1);
  });
  test("dry run reports planned lines without committing", async () => {
    const { d, commits } = deps([order("DRY", "2026-10-06T14:04:14Z")]);
    const r = await compensateRecentYouzanSales(d, { now: NOW, dryRun: true });
    assert.deepEqual(commits, []);
    assert.deepEqual(r.planned, [{ tid: "DRY", sourceOrderId: "DRY#oid:DRY-1#0", skuId: "sku-nara", locationId: "loc-xtd" }]);
  });
});

test("targeted tids still obey the window and floor", async () => {
  const seen: Array<{ since: string; tids?: string[] }> = [];
  const r = await compensateRecentYouzanSales({
    listOrders: async (q) => { seen.push(q); return []; },
    committedUnits: async () => ({}),
    adapter: () => { throw new Error("unused"); },
  }, { now: NOW, tids: ["E2026"], windowHours: 72 });
  assert.deepEqual(seen[0].tids, ["E2026"]);
  assert.ok(seen[0].since >= SALE_COMPENSATION_FLOOR);
  assert.equal(r.scanned, 0);
});
