import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { classifyOrderReference, resolveStorefrontOrderId } from "./storefront-orders.server";

const CUSTOMER = "11111111-2222-3333-4444-555555555555";
const ORDER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function deps(overrides: Partial<Parameters<typeof resolveStorefrontOrderId>[2]> = {}) {
  const calls: string[] = [];
  const base = {
    async findByOrderNo(orderNo: string, customerId: string) {
      calls.push(`order_no:${orderNo}:${customerId}`);
      return orderNo === "BO20260909100007" && customerId === CUSTOMER ? ORDER_ID : null;
    },
    async findByMerchantOrderNo(merchantOrderNo: string, customerId: string) {
      calls.push(`merchant:${merchantOrderNo}:${customerId}`);
      return merchantOrderNo === "0123456789abcdef0123456789abcdef" && customerId === CUSTOMER
        ? ORDER_ID
        : null;
    },
  };
  return { calls, deps: { ...base, ...overrides } };
}

test("classifies the three supported reference shapes and rejects anything else", () => {
  assert.equal(classifyOrderReference(ORDER_ID), "uuid");
  assert.equal(classifyOrderReference("BO20260909100007"), "order_no");
  assert.equal(classifyOrderReference("0123456789abcdef0123456789abcdef"), "merchant_order_no");
  for (const bad of ["", "   ", "BO", "bo-123", "0123456789abcdef0123456789abcde", "zzz".repeat(10), "'; drop table--", "BO2026 0909"]) {
    assert.equal(classifyOrderReference(bad), null, bad);
  }
});

test("uuid reference keeps existing behaviour without extra lookups", async () => {
  const f = deps();
  assert.equal(await resolveStorefrontOrderId(ORDER_ID, CUSTOMER, f.deps), ORDER_ID);
  assert.deepEqual(f.calls, []);
});

test("own shop order number resolves to the order id", async () => {
  const f = deps();
  assert.equal(await resolveStorefrontOrderId("BO20260909100007", CUSTOMER, f.deps), ORDER_ID);
  assert.deepEqual(f.calls, [`order_no:BO20260909100007:${CUSTOMER}`]);
});

test("own merchant order number resolves through the owning order", async () => {
  const f = deps();
  assert.equal(
    await resolveStorefrontOrderId("0123456789abcdef0123456789abcdef", CUSTOMER, f.deps),
    ORDER_ID,
  );
  assert.deepEqual(f.calls, [`merchant:0123456789abcdef0123456789abcdef:${CUSTOMER}`]);
});

test("another customer's references never resolve", async () => {
  const other = "99999999-9999-9999-9999-999999999999";
  const f = deps();
  assert.equal(await resolveStorefrontOrderId("BO20260909100007", other, f.deps), null);
  assert.equal(await resolveStorefrontOrderId("0123456789abcdef0123456789abcdef", other, f.deps), null);
});

test("unknown and malformed references resolve to null without lookups leaking", async () => {
  const f = deps();
  assert.equal(await resolveStorefrontOrderId("BO00000000000000", CUSTOMER, f.deps), null);
  assert.equal(await resolveStorefrontOrderId("ffffffffffffffffffffffffffffffff", CUSTOMER, f.deps), null);
  const g = deps();
  for (const bad of ["", "not-an-order", "0123456789abcdef0123456789abcde"]) {
    assert.equal(await resolveStorefrontOrderId(bad, CUSTOMER, g.deps), null);
  }
  assert.deepEqual(g.calls, []);
});

test("lookup failures surface as errors instead of a silent miss", async () => {
  const f = deps({
    async findByOrderNo() {
      throw new Error("db unavailable");
    },
  });
  await assert.rejects(resolveStorefrontOrderId("BO20260909100007", CUSTOMER, f.deps), /db unavailable/);
});

test("PostgREST merchant-order join uses the embedded alias for customer filter", async () => {
  const capturedUrls: string[] = [];
  const mockFetch = (_url: string | URL | Request) => {
    capturedUrls.push(typeof _url === "string" ? _url : String(_url));
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const client = createClient("https://test.supabase.co", "test-key", {
    global: { fetch: mockFetch as typeof fetch },
  });

  await client
    .from("commerce_payments")
    .select("order:commerce_orders!inner(id,customer_id)")
    .eq("merchant_order_no", "0123456789abcdef0123456789abcdef")
    .eq("order.customer_id", CUSTOMER);

  assert.equal(capturedUrls.length, 1);
  const decoded = decodeURIComponent(capturedUrls[0]!);
  assert.match(decoded, /select=order:commerce_orders!inner\(id,customer_id\)/);
  assert.match(decoded, /order\.customer_id=eq\.[0-9a-f-]{36}/);
  assert.doesNotMatch(decoded, /commerce_orders\.customer_id=eq\./);
  assert.match(decoded, /merchant_order_no=eq\.[0-9a-f]{32}/);
});
