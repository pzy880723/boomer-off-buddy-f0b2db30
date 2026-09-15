import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import {
  LOCATION_SELECT,
  ORDER_LIST_SELECT,
  OrderListError,
  countStorefrontOrders,
  listStorefrontOrders,
} from "./storefront-order-list-query.server";

const CUSTOMER = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-9999-9999-9999-999999999999";
const LOC_A = "aaaaaaaa-1111-1111-1111-111111111111";
const SHOP_A = "bbbbbbbb-1111-1111-1111-111111111111";

function orderRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    order_no: `BO2026090910000${i}`,
    order_status: "processing",
    payment_status: "paid",
    total_amount: 109.91,
    shipping_fee: 9.9,
    discount_total: 0,
    currency: "CNY",
    courier_provider: "sf",
    courier_service_code: "sf_standard",
    paid_at: "2026-09-09T14:10:00.000Z",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i)).toISOString(),
    courier_quote_snapshot: { groups: [{ location_id: LOC_A, store_name: "温州快照店", shipping_fee_fen: 990 }] },
    items: [
      {
        id: `item-${i}`,
        location_id: LOC_A,
        title_snapshot: "古着外套",
        image_snapshot: null,
        unit_price: 50,
        quantity: 2,
        line_total: 100,
        listing_id: null,
        sku_id: null,
        sku: { image_paths: ["sku-raw/a.jpg"], image_url: null },
        listing: null,
      },
    ],
    fulfillments: [{ location_id: LOC_A, status: "allocated" }],
    ...overrides,
  };
}

/** 用真实 supabase-js + mock fetch，断言实际发出的查询构造。 */
function mockClient(handler: (url: string) => unknown[] | { status: number; body: unknown }) {
  const urls: string[] = [];
  const fetchImpl = (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : String(input);
    urls.push(decodeURIComponent(url));
    const result = handler(decodeURIComponent(url));
    if (Array.isArray(result)) {
      return Promise.resolve(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const client = createClient("https://test.supabase.co", "test-key", {
    global: { fetch: fetchImpl as typeof fetch },
  });
  return { client, urls };
}

const signPaths = async (paths: readonly string[]) => paths.map(() => "https://signed/x");

test("每一批订单查询都按 customer_id 限定，且只选白名单字段", async () => {
  const { client, urls } = mockClient((url) => {
    if (url.includes("/inv_locations")) return [{ id: LOC_A, name: "温州仓", shop: { id: SHOP_A, shop_name: "温州店" } }];
    return [orderRow(1)];
  });
  const result = await listStorefrontOrders({
    client: client as never,
    customerId: CUSTOMER,
    url: new URL("https://x.test/api/public/storefront/orders"),
    signPaths,
  });

  const orderUrls = urls.filter((u) => u.includes("/commerce_orders"));
  assert.ok(orderUrls.length >= 1);
  for (const u of orderUrls) {
    assert.match(u, new RegExp(`customer_id=eq\\.${CUSTOMER}`));
    assert.doesNotMatch(u, new RegExp(OTHER));
    assert.match(u, /order=created_at\.desc,id\.desc/);
    // 字段白名单：不选个人信息 / 支付与结算快照 / EPC
    for (const forbidden of [
      "recipient_name",
      "recipient_phone",
      "shipping_address",
      "payment_route",
      "settlement_snapshot",
      "metadata",
      "epc",
      "customer_note",
    ]) {
      assert.doesNotMatch(u, new RegExp(forbidden), `${forbidden} 不应出现在查询里`);
    }
  }
  assert.equal(ORDER_LIST_SELECT.includes("recipient_phone"), false);
  assert.equal(LOCATION_SELECT.includes("address"), false);

  // 门店批量查询只有一次，没有逐单 N+1
  assert.equal(urls.filter((u) => u.includes("/inv_locations")).length, 1);

  const item = result.data[0]!;
  assert.equal(item.courier_provider, "sf");
  assert.equal(item.paid_at, "2026-09-09T14:10:00.000Z");
  assert.equal(item.shops[0]!.store_id, SHOP_A);
  assert.equal(item.shops[0]!.store_name, "温州快照店");
  assert.equal(item.shops[0]!.items[0]!.image_url, "https://signed/x");
  assert.equal("courier_quote_snapshot" in item, false);
});

test("翻页时每批仍带 customer_id 且游标写进 or 条件", async () => {
  let batch = 0;
  const { client, urls } = mockClient((url) => {
    if (url.includes("/inv_locations")) return [];
    batch += 1;
    // 第一批满 40 条触发下一批
    if (batch === 1) return Array.from({ length: 40 }, (_, i) => orderRow(i, { order_status: "completed" }));
    return [];
  });
  const page = await listStorefrontOrders({
    client: client as never,
    customerId: CUSTOMER,
    url: new URL("https://x.test/api/public/storefront/orders?status=paid"),
    signPaths,
  });
  const orderUrls = urls.filter((u) => u.includes("/commerce_orders"));
  assert.equal(orderUrls.length, 2);
  assert.ok(orderUrls.every((u) => u.includes(`customer_id=eq.${CUSTOMER}`)));
  assert.match(orderUrls[1]!, /or=\(created_at\.lt\..+,and\(created_at\.eq\..+,id\.lt\..+\)\)/);
  assert.equal(page.data.length, 0);
  assert.equal(page.has_more, false);
});

test("数据库错误抛 500，不当成空结果", async () => {
  const { client } = mockClient(() => ({ status: 500, body: { message: "db unavailable" } }));
  await assert.rejects(
    listStorefrontOrders({
      client: client as never,
      customerId: CUSTOMER,
      url: new URL("https://x.test/api/public/storefront/orders"),
      signPaths,
    }),
    (error: unknown) =>
      error instanceof OrderListError && error.status === 500 && /db unavailable/.test(error.message),
  );
});

test("门店查询失败抛 500", async () => {
  const { client } = mockClient((url) => {
    if (url.includes("/inv_locations")) return { status: 500, body: { message: "locations down" } };
    return [orderRow(1)];
  });
  await assert.rejects(
    listStorefrontOrders({
      client: client as never,
      customerId: CUSTOMER,
      url: new URL("https://x.test/api/public/storefront/orders"),
      signPaths,
    }),
    (error: unknown) => error instanceof OrderListError && error.status === 500,
  );
});

test("非法 status / limit / cursor 抛 400，且不打数据库", async () => {
  for (const qs of ["?status=refunded", "?limit=0", "?limit=999", "?cursor=zzz==="]) {
    const { client, urls } = mockClient(() => []);
    await assert.rejects(
      listStorefrontOrders({
        client: client as never,
        customerId: CUSTOMER,
        url: new URL(`https://x.test/api/public/storefront/orders${qs}`),
        signPaths,
      }),
      (error: unknown) => error instanceof OrderListError && error.status === 400,
      qs,
    );
    assert.deepEqual(urls, [], qs);
  }
});

test("未认证请求在查询之前被拒（GET 返回 401）", async () => {
  const { Route } = await import("@/routes/api/public/storefront/orders");
  const handler = (Route.options as unknown as {
    server: { handlers: { GET: (ctx: { request: Request }) => Promise<Response> } };
  }).server.handlers.GET;
  const response = await handler({
    request: new Request("https://x.test/api/public/storefront/orders"),
  });
  assert.equal(response.status, 401);
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test("历史 http 快照也必须经衍生签名器；签名失败为 null，绝不回退原图", async () => {
  const legacy = orderRow(7, {
    items: [
      {
        id: "item-legacy",
        location_id: LOC_A,
        title_snapshot: "旧单商品",
        image_snapshot: "https://legacy.example.com/storage/v1/object/public/parcel-item-images/x.jpg",
        unit_price: 10,
        quantity: 1,
        line_total: 10,
        listing_id: null,
        sku_id: null,
        sku: null,
        listing: null,
      },
    ],
  });
  const { client } = mockClient((url) => {
    if (url.includes("/inv_locations")) {
      return [{ id: LOC_A, name: "温州仓", shop: { id: SHOP_A, shop_name: "温州店" } }];
    }
    return [legacy];
  });

  const seen: string[][] = [];
  const result = await listStorefrontOrders({
    client: client as never,
    customerId: CUSTOMER,
    url: new URL("https://x.test/api/public/storefront/orders"),
    signPaths: async (paths) => {
      seen.push([...paths]);
      return paths.map(() => null); // 衍生图不可用
    },
  });

  assert.deepEqual(seen[0], [
    "https://legacy.example.com/storage/v1/object/public/parcel-item-images/x.jpg",
  ]);
  assert.equal(result.data[0].shops[0].items[0].image_url, null);
});

// ---- 角标计数：完整键集分页，历史订单绝不漏计 ----

test("超过一页的订单会继续翻页计数，不截断为最近 N 单", async () => {
  const total = 1201; // > 2 页（页大小 500）
  const rows = Array.from({ length: total }, (_, i) =>
    orderRow(i, {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      created_at: new Date(Date.UTC(2020, 0, 1) + (total - i) * 60_000).toISOString(),
      order_status: "processing",
      payment_status: "paid",
      fulfillments: [{ location_id: LOC_A, status: "allocated" }],
    }),
  );

  const { client, urls } = mockClient((url) => {
    if (!url.includes("/commerce_orders")) return [];
    const limit = Number(/limit=(\d+)/.exec(url)?.[1] ?? 500);
    const cursor = /created_at\.lt\.([^,)&]+)/.exec(url)?.[1];
    const start = cursor ? rows.findIndex((r) => r.created_at < cursor) : 0;
    return rows.slice(start < 0 ? rows.length : start, (start < 0 ? rows.length : start) + limit);
  });

  const counts = await countStorefrontOrders({
    client: client as never,
    customerId: CUSTOMER,
  });

  assert.equal(counts.awaiting_shipment, total);
  assert.ok(urls.filter((u) => u.includes("/commerce_orders")).length >= 3, "应至少翻 3 页");
  for (const u of urls) assert.match(u, new RegExp(`customer_id=eq\\.${CUSTOMER}`));
});

test("计数分页的每一页都带归属过滤，且只选最小列", async () => {
  const { client, urls } = mockClient(() => []);
  await countStorefrontOrders({ client: client as never, customerId: CUSTOMER, pageSize: 2 });
  const orderUrls = urls.filter((u) => u.includes("/commerce_orders"));
  assert.equal(orderUrls.length, 1);
  assert.match(orderUrls[0], new RegExp(`customer_id=eq\\.${CUSTOMER}`));
  for (const forbidden of ["recipient_phone", "shipping_address", "total_amount", "image"]) {
    assert.doesNotMatch(orderUrls[0], new RegExp(forbidden));
  }
});

test("计数读取失败必须抛错，不能当成 0 单", async () => {
  const { client } = mockClient(() => ({ status: 500, body: { message: "db down" } }));
  await assert.rejects(
    () => countStorefrontOrders({ client: client as never, customerId: CUSTOMER }),
    OrderListError,
  );
});
