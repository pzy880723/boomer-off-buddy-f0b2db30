import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compensateRecentYouzanSales, SALE_COMPENSATION_FLOOR, type CompensationDeps, type SkuMeta } from "./youzan-sale-compensation.server";

const NOW = new Date("2026-10-07T10:00:00Z");
type Line = { oid?: string; item_id: number; outer_sku_id: string; num: number; refund_state?: number };
const order = (tid: string, pay: string, over: Record<string, unknown> = {}, lines?: Line[]) => ({
  tid, shop_id: "shop-xtd", status: "TRADE_SUCCESS", pay_time: pay,
  raw: { full_order_info: {
    order_info: { tid, status: "TRADE_SUCCESS", offline_id: 212291308, refund_state: 0, ...(over.order_info as object ?? {}) },
    source_info: { is_offline_order: true },
    orders: lines ?? [{ oid: `${tid}-1`, item_id: 6480588312, outer_sku_id: "CUSTOM", num: 1 }],
  } },
  ...over,
});
const CUSTOM: SkuMeta = { scope: "custom", kind: "single", policy: "tracked", salesState: "on_sale" };
const STANDARD: SkuMeta = { scope: "standard", kind: "single", policy: "unlimited", salesState: "on_sale" };

function deps(rows: ReturnType<typeof order>[], opts: {
  processed?: string[]; failTid?: string; meta?: Record<string, SkuMeta>; qty?: number; restocked?: boolean; location?: string | null;
} = {}) {
  const commits: string[] = [];
  const seenSince: string[] = [];
  const pages: number[] = [];
  const sorted = [...rows].sort((a, b) => a.pay_time.localeCompare(b.pay_time) || a.tid.localeCompare(b.tid));
  const d: CompensationDeps = {
    listOrdersPage: async ({ since, limit, after }) => {
      seenSince.push(since);
      const page = sorted.filter((r) => r.pay_time >= since && (!after || r.pay_time > after.pay_time || (r.pay_time === after.pay_time && r.tid > after.tid))).slice(0, limit);
      pages.push(page.length);
      return page;
    },
    processedKeys: async () => new Set(opts.processed ?? []),
    skuMeta: async (ids) => new Map(ids.map((id) => [id, opts.meta?.[id] ?? CUSTOM])),
    locationQty: async () => opts.qty ?? 1,
    restockedAfter: async () => opts.restocked ?? false,
    adapter: () => ({
      findLocationId: async () => (opts.location === undefined ? "loc-xtd" : opts.location),
      findSkuId: async ({ lookupCodes }) => (lookupCodes.includes("STD") ? "sku-std" : "sku-custom"),
      commitSale: async (i) => {
        if (i.sourceOrderId.startsWith(opts.failTid ?? "~")) throw new Error("db timeout");
        commits.push(i.sourceOrderId); return { ok: true };
      },
    }),
  };
  return { d, commits, seenSince, pages };
}

describe("bounded recent Youzan sale compensation", () => {
  test("reuses one adapter across the window so repeated standard SKU reads are cached", async () => {
    const f = deps([order("ONE", "2026-10-06T12:00:00Z"), order("TWO", "2026-10-06T13:00:00Z")]);
    const original = f.d.adapter;
    let factories = 0;
    f.d.adapter = () => { factories++; return original(); };
    await compensateRecentYouzanSales(f.d, { now: NOW });
    assert.equal(factories, 1);
  });

  test("rejects an out-of-window or future row even if the database adapter returns it", async () => {
    const f = deps([]);
    f.d.listOrdersPage = async () => [order("OLD", "2026-09-20T00:00:00Z"), order("FUTURE", "2026-10-08T00:00:00Z")];
    await compensateRecentYouzanSales(f.d, { now: NOW });
    assert.deepEqual(f.commits, []);
  });
  test("window clamped to 72h and floor; history imports never deduct", async () => {
    const { d, commits, seenSince } = deps([order("OLD", "2026-09-20T00:00:00Z"), order("RECENT", "2026-10-06T14:04:14Z")]);
    const r = await compensateRecentYouzanSales(d, { now: NOW, windowHours: 500 });
    assert.ok(seenSince[0] >= SALE_COMPENSATION_FLOOR);
    assert.ok(Date.parse(seenSince[0]) >= NOW.getTime() - 72 * 3600_000);
    assert.deepEqual(commits, ["RECENT#oid:RECENT-1#0"]);
    assert.equal(r.committed, 1);
  });

  test("regression: >30 orders, first 30 fully processed, the 31st custom miss is still compensated (no starvation)", async () => {
    const rows = Array.from({ length: 31 }, (_, i) => order(`T${String(i).padStart(2, "0")}`, `2026-10-06T${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 5).padStart(2, "0")}:00Z`));
    const processed = rows.slice(0, 30).map((r) => `${r.tid}#oid:${r.tid}-1#0`);
    const { d, commits, pages } = deps(rows, { processed });
    const r = await compensateRecentYouzanSales(d, { now: NOW, limit: 30 });
    assert.deepEqual(commits, ["T30#oid:T30-1#0"]);
    assert.equal(r.scanned, 31);
    assert.equal(r.already, 30);
    assert.ok(pages.length >= 2, "paginates past the first page");
  });

  test("oversold/failed events are not treated as done: only processed keys count", async () => {
    // processedKeys only returns status=processed; an oversold row for the key is absent → retried
    const { d, commits } = deps([order("OVS", "2026-10-06T12:00:00Z")], { processed: [] });
    await compensateRecentYouzanSales(d, { now: NOW });
    assert.deepEqual(commits, ["OVS#oid:OVS-1#0"]);
  });

  test("legacy positional key processed also counts as done for that unit", async () => {
    const { d, commits } = deps([order("LEG", "2026-10-06T12:00:00Z")], { processed: ["LEG#0#0"] });
    const r = await compensateRecentYouzanSales(d, { now: NOW });
    assert.deepEqual(commits, []);
    assert.equal(r.already, 1);
  });

  test("standard unlimited lines are never compensated, and filtering keeps original line indexes", async () => {
    const lines: Line[] = [
      { oid: "a", item_id: 1, outer_sku_id: "STD", num: 3 },
      { item_id: 2, outer_sku_id: "CUSTOM", num: 1 },
    ];
    const { d, commits } = deps([order("MIX", "2026-10-06T12:00:00Z", {}, lines)], { meta: { "sku-std": STANDARD } });
    const r = await compensateRecentYouzanSales(d, { now: NOW });
    assert.deepEqual(commits, ["MIX#1#0"], "custom line keeps legacy index 1");
    assert.equal(r.notCustom, 3);
  });

  test("skips when no location, no stock at that location, or restocked after the sale (inventory version)", async () => {
    for (const [o, key] of [[{ location: null }, "noLocation"], [{ qty: 0 }, "noStock"], [{ restocked: true }, "versionConflict"]] as const) {
      const { d, commits } = deps([order("G", "2026-10-06T12:00:00Z")], o);
      const r = await compensateRecentYouzanSales(d, { now: NOW });
      assert.deepEqual(commits, [], key);
      assert.equal((r as Record<string, unknown>)[key], 1, key);
    }
  });

  test("refunded/closed orders and refunded lines are skipped", async () => {
    const lines: Line[] = [{ oid: "r", item_id: 1, outer_sku_id: "CUSTOM", num: 1, refund_state: 2 }];
    const { d, commits } = deps([
      order("REF", "2026-10-06T10:00:00Z", { order_info: { refund_state: 2 } }),
      order("CLOSED", "2026-10-06T11:00:00Z", { status: "TRADE_CLOSED" }),
      order("LREF", "2026-10-06T12:00:00Z", {}, lines),
    ]);
    await compensateRecentYouzanSales(d, { now: NOW });
    assert.deepEqual(commits, []);
  });

  test("a failing order is reported and does not block others", async () => {
    const { d, commits } = deps([order("BAD", "2026-10-06T12:00:00Z"), order("GOOD", "2026-10-06T13:00:00Z")], { failTid: "BAD" });
    const r = await compensateRecentYouzanSales(d, { now: NOW });
    assert.equal(r.failed, 1);
    assert.deepEqual(commits, ["GOOD#oid:GOOD-1#0"]);
  });

  test("dry run reports planned lines without committing", async () => {
    const { d, commits } = deps([order("DRY", "2026-10-06T14:04:14Z")]);
    const r = await compensateRecentYouzanSales(d, { now: NOW, dryRun: true });
    assert.deepEqual(commits, []);
    assert.deepEqual(r.planned, [{ tid: "DRY", sourceOrderId: "DRY#oid:DRY-1#0", skuId: "sku-custom", locationId: "loc-xtd" }]);
  });

  test("all three branches use their own order identity, location and custom stock", async () => {
    const shops = [
      { id: "shop-xtd", kdt: 212291308, location: "loc-xtd" },
      { id: "shop-citic", kdt: 187395218, location: "loc-citic" },
      { id: "shop-wenzhou", kdt: 178113306, location: "loc-wenzhou" },
    ];
    const rows = shops.map((shop, i) => order(`BRANCH${i}`, "2026-10-06T12:00:00Z", {
      shop_id: shop.id, order_info: { offline_id: shop.kdt },
    }));
    const f = deps(rows);
    const received: Array<{ shop: string; location: string | null; sku: string }> = [];
    f.d.locationQty = async (sku, location) => shops.some(s => location === s.location && sku === `sku-${s.id}`) ? 1 : 0;
    f.d.adapter = () => ({
      findLocationId: async (shopId, kdt) => {
        const shop = shops.find(s => s.id === shopId);
        assert.ok(shop);
        if (kdt !== undefined) assert.equal(kdt, shop.kdt);
        return shop.location;
      },
      findSkuId: async ({ shopId }) => `sku-${shopId}`,
      commitSale: async input => {
        received.push({ shop: input.shopId, location: input.locationId, sku: input.skuId });
        return { ok: true };
      },
    });
    const r = await compensateRecentYouzanSales(f.d, { now: NOW });
    assert.equal(r.failed, 0);
    assert.equal(r.committed, 3);
    assert.deepEqual(received, shops.map(s => ({ shop: s.id, location: s.location, sku: `sku-${s.id}` })));
  });
});
