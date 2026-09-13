import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildImageMap,
  buildOrderListItem,
  coarseStatusFilter,
  collectImageRefs,
  decodeOrderCursor,
  deriveDisplayStatus,
  deriveShopStatus,
  encodeOrderCursor,
  matchesStatusFilter,
  parseOrdersListQuery,
  resolveItemImageRef,
  selectOrdersPage,
  snapshotShippingFeeFen,
  snapshotStoreName,
  type OrderRow,
  type StoreInfo,
} from "./storefront-order-list.server";

const LOC_A = "11111111-1111-1111-1111-111111111111";
const LOC_B = "22222222-2222-2222-2222-222222222222";
const SHOP_A = "aaaaaaaa-1111-1111-1111-111111111111";
const ORDER_ID = "33333333-3333-3333-3333-333333333333";

function stores(): Map<string, StoreInfo> {
  return new Map([
    [LOC_A, { store_id: SHOP_A, store_name: "温州店" }],
    [LOC_B, { store_id: null, store_name: "杭州仓" }],
  ]);
}

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER_ID,
    order_no: "BO20260909100007",
    order_status: "processing",
    payment_status: "paid",
    total_amount: 109.91,
    shipping_fee: 9.9,
    discount_total: 5,
    currency: "CNY",
    created_at: "2026-09-09T14:08:43.999Z",
    courier_quote_snapshot: {
      groups: [
        { location_id: LOC_A, store_name: "温州快照店", shipping_fee_fen: 990 },
        { location_id: LOC_B, store_name: "杭州快照仓", shipping_fee_fen: 0 },
      ],
    },
    items: [
      {
        id: "item-a1",
        location_id: LOC_A,
        title_snapshot: "古着外套",
        image_snapshot: "https://cdn.example.com/a.jpg",
        unit_price: 50,
        quantity: 2,
        line_total: 100,
        listing_id: null,
      },
    ],
    fulfillments: [{ location_id: LOC_A, status: "allocated" }],
    ...overrides,
  };
}

/* ------------------------------- 状态判定 ------------------------------- */

test("状态判定：取消/退款优先，processing 视为待发货", () => {
  assert.equal(deriveDisplayStatus(order()), "paid");
  assert.equal(
    deriveDisplayStatus(order({ fulfillments: [{ location_id: LOC_A, status: "handed_over" }] })),
    "shipped",
  );
  assert.equal(deriveDisplayStatus(order({ order_status: "completed" })), "completed");
  assert.equal(
    deriveDisplayStatus(order({ order_status: "pending_payment", payment_status: "unpaid" })),
    "pending_payment",
  );
  assert.equal(deriveDisplayStatus(order({ order_status: "cancelled", payment_status: "unpaid" })), "cancelled");
  // 退款优先于 completed / cancelled
  assert.equal(deriveDisplayStatus(order({ order_status: "completed", payment_status: "refunded" })), "refunded");
  assert.equal(
    deriveDisplayStatus(order({ order_status: "cancelled", payment_status: "refund_pending" })),
    "refunded",
  );
});

test("混合履约：部分门店已交接不算整单已发货", () => {
  const mixed = order({
    fulfillments: [
      { location_id: LOC_A, status: "handed_over" },
      { location_id: LOC_B, status: "picking" },
    ],
  });
  assert.equal(deriveDisplayStatus(mixed), "paid");
  assert.equal(matchesStatusFilter(mixed, "shipped"), false);
  assert.equal(matchesStatusFilter(mixed, "paid"), true);
  assert.equal(matchesStatusFilter(mixed, "all"), true);
});

test("SQL 粗筛只用订单表列", () => {
  assert.deepEqual(coarseStatusFilter("all"), {});
  assert.deepEqual(coarseStatusFilter("pending_payment"), {
    orderStatuses: ["pending_payment"],
    paymentStatuses: ["unpaid"],
  });
  assert.deepEqual(coarseStatusFilter("paid"), coarseStatusFilter("shipped"));
  assert.deepEqual(coarseStatusFilter("completed"), { orderStatuses: ["completed"] });
});

/* -------------------------------- 游标 -------------------------------- */

test("游标可往返，且拒绝注入/篡改", () => {
  const cur = encodeOrderCursor({ created_at: "2026-09-09T14:08:43.999Z", id: ORDER_ID });
  assert.deepEqual(decodeOrderCursor(cur), { created_at: "2026-09-09T14:08:43.999Z", id: ORDER_ID });
  for (const bad of [
    "",
    "not-base64!!",
    Buffer.from("2026-09-09T14:08:43.999Z|not-a-uuid").toString("base64url"),
    Buffer.from(`2026-09-09),cancel|${ORDER_ID}`).toString("base64url"),
    Buffer.from(`' or 1=1--|${ORDER_ID}`).toString("base64url"),
    Buffer.from(ORDER_ID).toString("base64url"),
  ]) {
    assert.throws(() => decodeOrderCursor(bad), /Invalid cursor/, bad);
  }
});

test("查询参数：默认每页 20，非法 status/limit/cursor 抛错", () => {
  const base = "https://x.test/api/public/storefront/orders";
  assert.deepEqual(parseOrdersListQuery(new URL(base)), { status: "all", limit: 20, cursor: null });
  assert.equal(parseOrdersListQuery(new URL(`${base}?status=shipped&limit=5`)).limit, 5);
  assert.throws(() => parseOrdersListQuery(new URL(`${base}?status=refunded`)), /Invalid status/);
  assert.throws(() => parseOrdersListQuery(new URL(`${base}?limit=0`)), /Invalid limit/);
  assert.throws(() => parseOrdersListQuery(new URL(`${base}?limit=999`)), /Invalid limit/);
  assert.throws(() => parseOrdersListQuery(new URL(`${base}?cursor=zzz%3D%3D%3D`)), /Invalid cursor/);
});

/* -------------------------------- 快照 -------------------------------- */

test("门店名优先历史快照，运费缺失为 null、0 保留 0", () => {
  const snap = order().courier_quote_snapshot;
  assert.equal(snapshotStoreName(snap, LOC_A), "温州快照店");
  assert.equal(snapshotShippingFeeFen(snap, LOC_A), 990);
  assert.equal(snapshotShippingFeeFen(snap, LOC_B), 0);
  assert.equal(snapshotStoreName(null, LOC_A), null);
  assert.equal(snapshotShippingFeeFen(null, LOC_A), null);
  assert.equal(snapshotShippingFeeFen({ groups: [] }, LOC_A), null);
});

/* ------------------------------- 分组组装 ------------------------------ */

test("单店订单：金额换算、商品小计只含商品、总金额取订单表", () => {
  const item = buildOrderListItem(order(), { stores: stores(), images: new Map([["item-a1", "https://img/a"]]) });
  assert.equal(item.total_amount, 109.91);
  assert.equal(item.shipping_fee, 9.9);
  assert.equal(item.discount_amount, 5);
  assert.equal(item.display_status, "paid");
  assert.equal(item.shops.length, 1);
  const shop = item.shops[0]!;
  assert.equal(shop.location_id, LOC_A);
  assert.equal(shop.store_id, SHOP_A);
  assert.equal(shop.store_name, "温州快照店");
  assert.equal(shop.status, "allocated");
  assert.equal(shop.shipping_fee_fen, 990);
  assert.equal(shop.subtotal_fen, 10000);
  assert.deepEqual(shop.items, [
    { id: "item-a1", title: "古着外套", image_url: "https://img/a", unit_price: 50, quantity: 2, line_total: 100 },
  ]);
  // 不下发规格/地址/电话/EPC/支付快照
  assert.deepEqual(Object.keys(shop.items[0]!).sort(), [
    "id",
    "image_url",
    "line_total",
    "quantity",
    "title",
    "unit_price",
  ]);
  assert.equal("recipient_phone" in item, false);
  assert.equal("courier_quote_snapshot" in item, false);
});

test("多店订单：按 location_id 分组、各店履约状态独立、无快照运费为 null", () => {
  const row = order({
    courier_quote_snapshot: { groups: [{ location_id: LOC_A, store_name: "温州快照店", shipping_fee_fen: 990 }] },
    items: [
      { id: "i1", location_id: LOC_A, title_snapshot: "A", image_snapshot: null, unit_price: 10, quantity: 1, line_total: 10, listing_id: null },
      { id: "i2", location_id: LOC_B, title_snapshot: "B", image_snapshot: null, unit_price: 20, quantity: 2, line_total: 40, listing_id: null },
      { id: "i3", location_id: LOC_A, title_snapshot: "C", image_snapshot: null, unit_price: 5, quantity: 1, line_total: 5, listing_id: null },
    ],
    fulfillments: [
      { location_id: LOC_A, status: "handed_over" },
      { location_id: LOC_B, status: "picking" },
    ],
  });
  const item = buildOrderListItem(row, { stores: stores(), images: new Map() });
  assert.equal(item.shops.length, 2);
  const [a, b] = item.shops;
  assert.equal(a!.store_name, "温州快照店");
  assert.equal(a!.status, "handed_over");
  assert.equal(a!.subtotal_fen, 1500);
  assert.equal(a!.shipping_fee_fen, 990);
  assert.equal(b!.store_name, "杭州仓"); // 快照缺该店 → 回退关联门店名
  assert.equal(b!.status, "picking");
  assert.equal(b!.subtotal_fen, 4000);
  assert.equal(b!.shipping_fee_fen, null); // 不摊派
  assert.equal(b!.items.every((i) => i.image_url === null), true);
});

test("取消/退款优先覆盖门店履约状态", () => {
  assert.equal(deriveShopStatus("cancelled", "picking"), "cancelled");
  assert.equal(deriveShopStatus("refunded", "handed_over"), "refunded");
  assert.equal(deriveShopStatus("pending_payment", null), "pending_payment");
  assert.equal(deriveShopStatus("paid", null), "unallocated");
  const cancelled = buildOrderListItem(
    order({ order_status: "cancelled", payment_status: "refunded" }),
    { stores: stores(), images: new Map() },
  );
  assert.equal(cancelled.display_status, "refunded");
  assert.equal(cancelled.shops[0]!.status, "refunded");
});

/* -------------------------------- 图片 -------------------------------- */

test("图源：快照优先，缺失回退 listing 首图/封面，未知为 null", () => {
  assert.deepEqual(resolveItemImageRef({ id: "a", location_id: null, title_snapshot: null, image_snapshot: "https://c/a.jpg", unit_price: 0, quantity: 1, line_total: 0, listing_id: null }), { kind: "direct", value: "https://c/a.jpg" });
  assert.deepEqual(
    resolveItemImageRef({ id: "b", location_id: null, title_snapshot: null, image_snapshot: null, unit_price: 0, quantity: 1, line_total: 0, listing_id: null, listing: { image_paths: ["sku-listing/x/y.jpg"], cover_url: null } }),
    { kind: "path", value: "sku-listing/x/y.jpg" },
  );
  assert.deepEqual(
    resolveItemImageRef({ id: "c", location_id: null, title_snapshot: null, image_snapshot: "  ", unit_price: 0, quantity: 1, line_total: 0, listing_id: null, listing: { image_paths: [], cover_url: "https://c/cover.jpg" } }),
    { kind: "direct", value: "https://c/cover.jpg" },
  );
  assert.equal(
    resolveItemImageRef({ id: "d", location_id: null, title_snapshot: null, image_snapshot: null, unit_price: 0, quantity: 1, line_total: 0, listing_id: null }),
    null,
  );
});

test("整页图片一次批量签名，签名失败回落 null", () => {
  const rows = [
    order({
      items: [
        { id: "i1", location_id: LOC_A, title_snapshot: "A", image_snapshot: "sku-listing/p1.jpg", unit_price: 1, quantity: 1, line_total: 1, listing_id: null },
        { id: "i2", location_id: LOC_A, title_snapshot: "B", image_snapshot: "sku-listing/p1.jpg", unit_price: 1, quantity: 1, line_total: 1, listing_id: null },
        { id: "i3", location_id: LOC_B, title_snapshot: "C", image_snapshot: "sku-raw/p2.jpg", unit_price: 1, quantity: 1, line_total: 1, listing_id: null },
        { id: "i4", location_id: LOC_B, title_snapshot: "D", image_snapshot: null, unit_price: 1, quantity: 1, line_total: 1, listing_id: null },
      ],
    }),
  ];
  const { refs, paths } = collectImageRefs(rows);
  assert.deepEqual(paths, ["sku-listing/p1.jpg", "sku-raw/p2.jpg"]); // 去重
  const images = buildImageMap(refs, paths, ["https://signed/1", null]);
  assert.equal(images.get("i1"), "https://signed/1");
  assert.equal(images.get("i2"), "https://signed/1");
  assert.equal(images.get("i3"), null);
  assert.equal(images.get("i4"), null);
});

/* -------------------------------- 分页 -------------------------------- */

function seq(n: number, make: (i: number) => Partial<OrderRow>): OrderRow[] {
  return Array.from({ length: n }, (_, i) =>
    order({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString(),
      ...make(i),
    }),
  );
}

test("分页：每页 20，has_more 与 next_cursor 稳定", async () => {
  const all = seq(45, () => ({}));
  const fetchBatch = async ({ cursor, size }: { cursor: { created_at: string; id: string } | null; size: number }) => {
    const start = cursor ? all.findIndex((r) => r.id === cursor.id) + 1 : 0;
    return all.slice(start, start + size);
  };
  const page1 = await selectOrdersPage(fetchBatch, { status: "all", limit: 20, cursor: null });
  assert.equal(page1.rows.length, 20);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.rows[0]!.id, all[0]!.id);

  const page2 = await selectOrdersPage(fetchBatch, {
    status: "all",
    limit: 20,
    cursor: decodeOrderCursor(page1.nextCursor!),
  });
  assert.equal(page2.rows.length, 20);
  assert.equal(page2.rows[0]!.id, all[20]!.id);

  const page3 = await selectOrdersPage(fetchBatch, {
    status: "all",
    limit: 20,
    cursor: decodeOrderCursor(page2.nextCursor!),
  });
  assert.equal(page3.rows.length, 5);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, null);
  // 三页无重复
  const ids = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
  assert.equal(new Set(ids).size, 45);
});

test("分页：精筛在 JS，shipped 过滤跨批仍能凑满一页", async () => {
  const all = seq(40, (i) => ({
    fulfillments: [{ location_id: LOC_A, status: i % 4 === 0 ? "handed_over" : "picking" }],
  }));
  const fetchBatch = async ({ cursor, size }: { cursor: { created_at: string; id: string } | null; size: number }) => {
    const start = cursor ? all.findIndex((r) => r.id === cursor.id) + 1 : 0;
    return all.slice(start, start + size);
  };
  const page = await selectOrdersPage(fetchBatch, { status: "shipped", limit: 20, cursor: null }, { batchSize: 10 });
  assert.equal(page.rows.length, 10);
  assert.equal(page.rows.every((r) => deriveDisplayStatus(r) === "shipped"), true);
  assert.equal(page.hasMore, false);
});

test("归属隔离：取数层按 customer_id 过滤，helper 不会引入他人订单", async () => {
  const mine = seq(3, () => ({}));
  const seen: Array<string | null> = [];
  const fetchBatch = async ({ cursor }: { cursor: { created_at: string; id: string } | null; size: number }) => {
    seen.push(cursor?.id ?? null);
    return cursor ? [] : mine;
  };
  const page = await selectOrdersPage(fetchBatch, { status: "all", limit: 20, cursor: null });
  assert.equal(page.rows.length, 3);
  assert.deepEqual(page.rows.map((r) => r.id), mine.map((r) => r.id));
  assert.deepEqual(seen, [null]);
});
