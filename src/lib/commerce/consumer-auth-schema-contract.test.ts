import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260726153000_consumer_identity.sql", import.meta.url),
  "utf8",
);
const ordersRoute = readFileSync(
  new URL("../../routes/api/public/storefront/orders.ts", import.meta.url),
  "utf8",
);
const orderDetailRoute = readFileSync(
  new URL("../../routes/api/public/storefront/orders.$id.ts", import.meta.url),
  "utf8",
);
const orderListQuery = readFileSync(
  new URL("../../server/storefront-order-list-query.server.ts", import.meta.url),
  "utf8",
);
const paymentsRoute = readFileSync(
  new URL("../../routes/api/public/storefront/payments.ts", import.meta.url),
  "utf8",
);

describe("consumer identity is independent from ERP employee auth", () => {
  test("stores Tencent subjects and linked login providers", () => {
    assert.match(migration, /CREATE TABLE public\.commerce_customers/i);
    assert.match(migration, /external_subject text NOT NULL UNIQUE/i);
    assert.match(migration, /CREATE TABLE public\.commerce_customer_identities/i);
    assert.match(migration, /provider IN \('phone','wechat'\)/i);
  });

  test("storefront order and payment ownership uses customer_id", () => {
    // 列表/计数已下沉到查询层：路由只能把已验证顾客 id 传入，查询层的每次订单读取都按该 id 过滤。
    const routeCustomerArgs = ordersRoute.match(/customerId:\s*[^,\n}]+/g) ?? [];
    assert.ok(routeCustomerArgs.length >= 1, "orders route must pass customerId to the query layer");
    for (const arg of routeCustomerArgs) assert.match(arg, /^customerId:\s*auth\.customer\.id$/);
    assert.doesNotMatch(ordersRoute, /customer_id["']?\s*[:=]\s*(body|url|request|searchParams)/);
    const orderReads = orderListQuery.split('.from("commerce_orders")').length - 1;
    const ownerFilters = (orderListQuery.match(/\.eq\("customer_id", (customerId|options\.customerId)\)/g) ?? []).length;
    assert.ok(orderReads >= 2 && ownerFilters >= orderReads, `every commerce_orders read must filter by customer_id (${ownerFilters}/${orderReads})`);
    assert.match(orderDetailRoute, /\.eq\("customer_id", auth\.customer\.id\)/);
    assert.match(paymentsRoute, /\.eq\("customer_id", auth\.customer\.id\)/);
    assert.doesNotMatch(ordersRoute, /\.eq\("user_id", auth\.user\.id\)/);
    assert.doesNotMatch(paymentsRoute, /\.eq\("user_id", auth\.user\.id\)/);
  });
});
