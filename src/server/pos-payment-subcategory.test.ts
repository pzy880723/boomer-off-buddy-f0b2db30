import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let tables: Record<string, any[]>;
let categoryError: boolean;
let categoryReads: number;
let providerCalls: any[];
let saleCalls: any[];
const supabaseAdmin = {
  auth: {
    getUser: async () => ({ data: { user: { id: id(1), email: null } }, error: null }),
    admin: { getUserById: async () => ({ data: { user: { email: "test@example.invalid" } } }) },
  },
  from(table: string) {
    let columns = "*";
    let inserted: any;
    let patch: any;
    const filters: Array<(row: any) => boolean> = [];
    const execute = async (single: boolean) => {
      if (table === "inv_categories") {
        categoryReads += 1;
        if (categoryError) return { data: null, error: { message: "category query failed" } };
      }
      if (inserted) (tables[table] ??= []).push({ id: id(10), ...structuredClone(inserted) });
      const rows = (tables[table] ?? []).filter((row) => filters.every((fn) => fn(row)));
      if (patch) rows.forEach((row) => Object.assign(row, structuredClone(patch)));
      const selected = rows.map((row) =>
        columns === "*"
          ? structuredClone(row)
          : Object.fromEntries(columns.split(",").map((key) => [key, structuredClone(row[key])])),
      );
      return { data: single ? (selected[0] ?? null) : selected, error: null };
    };
    const query = {
      select: (value: string) => {
        columns = value;
        return query;
      },
      eq: (key: string, value: unknown) => {
        filters.push((row) => row[key] === value);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[key]));
        return query;
      },
      insert: (value: any) => {
        inserted = value;
        return query;
      },
      update: (value: any) => {
        patch = value;
        return query;
      },
      maybeSingle: () => execute(true),
      single: () => execute(true),
      then: (resolve: (value: unknown) => unknown) => execute(false).then(resolve),
    };
    return query;
  },
  rpc: async (name: string, args: any) => {
    if (name === "sales_sku_available_qty") return { data: 100, error: null };
    assert.equal(name, "pos_complete_sale_v2");
    saleCalls.push(structuredClone(args));
    return { data: { order_id: id(11) }, error: null };
  },
};
const provider = {
  sha256Hex: async () => "test-only-hash",
  providerConfigured: () => ({ ok: true, config: {} }),
  wechatNative: async (args: any) => {
    providerCalls.push(args);
    return { status: "pending", qrContent: "test-qr", raw: {} };
  },
  alipayPrecreate: async (args: any) => {
    providerCalls.push(args);
    return { status: "pending", qrContent: "test-qr", raw: {} };
  },
  wechatMicropay: async (args: any) => {
    providerCalls.push(args);
    return { status: "user_paying", raw: {} };
  },
  alipayMicropay: async (args: any) => {
    providerCalls.push(args);
    return { status: "user_paying", raw: {} };
  },
};
(globalThis as any).__posPaymentSubcategoryTest = { supabaseAdmin, provider };
const bundle = await build({
  stdin: {
    contents: `export { Route as qr } from './src/routes/api/public/pos/payments.qr-order.ts';
      export { Route as micropay } from './src/routes/api/public/pos/payments.micropay.ts';
      export { finalizePaidAttempt, attemptResponse } from './src/server/pos-payment.server.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "payment-subcategory-boundaries",
      setup(builder: any) {
        builder.onResolve(
          {
            filter:
              /^(@tanstack\/react-router|@\/integrations\/supabase\/client.server|@\/server\/pos-payment-provider.server)$/,
          },
          (args: any) => ({ path: args.path, namespace: "stub" }),
        );
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args: any) => ({
          contents:
            args.path === "@tanstack/react-router"
              ? "export const createFileRoute = () => options => options;"
              : args.path.includes("client.server")
                ? "export const {supabaseAdmin} = globalThis.__posPaymentSubcategoryTest;"
                : "export const {sha256Hex,providerConfigured,wechatNative,alipayPrecreate,wechatMicropay,alipayMicropay} = globalThis.__posPaymentSubcategoryTest.provider;",
        }));
      },
    },
  ],
});
const { qr, micropay, finalizePaidAttempt, attemptResponse } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
beforeEach(() => {
  categoryError = false;
  categoryReads = 0;
  providerCalls = [];
  saleCalls = [];
  tables = {
    user_roles: [{ user_id: id(1), role: "store_staff" }],
    user_location_perms: [{ user_id: id(1), location_id: id(2) }],
    inv_locations: [{ id: id(2), name: "TEST", kind: "shop", is_active: true }],
    pos_shifts: [{ id: id(3), location_id: id(2), operator_id: id(1), status: "open" }],
    store_payment_profiles: [
      { id: id(4), location_id: id(2), subject_id: id(5), is_enabled: true, status: "active" },
    ],
    payment_subjects: [
      {
        id: id(5),
        legal_name: "TEST",
        erp_verification_status: "approved",
        provider_application_status: "active",
        wechat_sub_mchid: "TEST",
        alipay_seller_id: "TEST",
      },
    ],
    inv_skus: [
      {
        id: id(6),
        name: "Porcelain",
        price_tier: 10,
        status: "active",
        is_display: true,
        sale_ownership: "owned",
        discount_eligible: true,
        category: "porcelain_eu",
        sku_code: "TEST",
      },
    ],
    inv_categories: [
      { id: id(7), code: "porcelain_eu", parent_id: null, is_active: true },
      { id: id(8), code: "cup", parent_id: id(7), is_active: true },
      { id: id(9), code: "plate", parent_id: id(7), is_active: true },
      { id: id(19), code: "foreign", parent_id: id(99), is_active: true },
      { id: id(20), code: "disabled", parent_id: id(7), is_active: false },
    ],
    pos_payment_attempts: [],
    inv_brands: [
      { id: id(30), name: "Brand A", status: "active", entity_type: "brand" },
      { id: id(31), name: "Brand B", status: "active", entity_type: "kiln" },
      { id: id(32), name: "Disabled", status: "inactive", entity_type: "brand" },
      { id: id(33), name: "Character", status: "active", entity_type: "ip" },
    ],
    commerce_orders: [
      { id: id(11), order_no: "TEST", subtotal: 30, discount_total: 0, total_amount: 30 },
    ],
    commerce_order_items: ["cup", "plate", null].map((tag) => ({
      order_id: id(11),
      sku_id: id(6),
      title_snapshot: "Porcelain",
      quantity: 1,
      unit_price: 10,
      line_total: 10,
      category_code: "porcelain_eu",
      category_name_snapshot: "Porcelain",
      subcategory_code: tag,
      subcategory_name_snapshot: tag,
    })),
    pos_receipts: [{ order_id: id(11), receipt_no: "TEST" }],
  };
});
const taggedItems = () =>
  ["cup", "plate", null].map((subcategory_code) => ({
    sku_id: id(6),
    quantity: 1,
    subcategory_code,
  }));
async function submit(route: any, items: any[], payProvider = "wechat") {
  return route.server.handlers.POST({
    request: new Request("https://erp.invalid/test", {
      method: "POST",
      headers: { authorization: "Bearer test" },
      body: JSON.stringify({
        location_id: id(2),
        shift_id: id(3),
        client_op_id: "test-tagged-op",
        provider: payProvider,
        auth_code: payProvider === "wechat" ? "101234567890123456" : "251234567890123456",
        items,
      }),
    }),
  });
}

for (const [name, route] of [
  ["QR", qr],
  ["micropay", micropay],
] as const) {
  test(`${name} preserves brand IDs through provider and final sale`, async () => {
    const items = [30,31].map((n) => ({ sku_id:id(6), quantity:1, brand_id:id(n) }));
    const response = await submit(route, items);
    assert.ok(response.ok);
    const attempt = tables.pos_payment_attempts[0];
    assert.deepEqual(attempt.sale_payload.items, items);
    await finalizePaidAttempt(attempt, { providerTransactionId:"TEST-BRAND" });
    assert.deepEqual(saleCalls[0].p_items, items);
  });
  for (const n of [32,33,99]) test(`${name} rejects invalid brand ${n} before provider`, async () => {
    const response = await submit(route, [{sku_id:id(6),quantity:1,brand_id:id(n)}]);
    assert.equal(response.status,422);
    assert.equal(providerCalls.length,0);
    assert.equal(tables.pos_payment_attempts.length,0);
  });
  for (const payProvider of ["wechat", "alipay"]) {
    test(`${name}/${payProvider} preserves same-SKU distinct tags through attempt, paid finalization and receipt`, async () => {
      const expected = taggedItems();
      const response = await submit(route, expected, payProvider);
      assert.ok(response.ok);
      assert.equal(providerCalls.length, 1);
      assert.equal(providerCalls[0].amount, 30);
      const attempt = tables.pos_payment_attempts[0];
      assert.deepEqual(attempt.sale_payload.items, expected);
      const paid = await finalizePaidAttempt(attempt, {
        providerTransactionId: "TEST-TRANSACTION",
      });
      assert.deepEqual(saleCalls[0].p_items, expected);
      const result = await attemptResponse(paid);
      assert.deepEqual(
        result.receipt.items.map((item: any) => item.subcategory_code),
        ["cup", "plate", null],
      );
      assert.deepEqual(
        result.receipt.items.map((item: any) => item.subcategory_name_snapshot),
        ["cup", "plate", null],
      );
      assert.ok(result.receipt.items.every((item: any) => item.category_code === "porcelain_eu"));
    });
  }
  for (const code of ["foreign", "disabled", "unknown", "porcelain_eu"]) {
    test(`${name} rejects ${code} tag before creating attempt or calling payment provider`, async () => {
      const response = await submit(route, [
        { sku_id: id(6), quantity: 1, subcategory_code: code },
      ]);
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, "invalid_subcategory");
      assert.equal(providerCalls.length, 0);
      assert.equal(tables.pos_payment_attempts.length, 0);
      assert.equal(saleCalls.length, 0);
    });
  }
  test(`${name} fails closed on category lookup failure before charging`, async () => {
    categoryError = true;
    const response = await submit(route, taggedItems());
    assert.equal(response.status, 500);
    assert.equal(providerCalls.length, 0);
    assert.equal(tables.pos_payment_attempts.length, 0);
  });
  test(`${name} keeps old clients with missing or null tags compatible`, async () => {
    const items = [
      { sku_id: id(6), quantity: 1 },
      { sku_id: id(6), quantity: 1, subcategory_code: null },
    ];
    const response = await submit(route, items);
    assert.ok(response.ok);
    assert.deepEqual(tables.pos_payment_attempts[0].sale_payload.items, items);
    assert.equal(providerCalls[0].amount, 20);
    assert.equal(categoryReads, 0);
  });
}
