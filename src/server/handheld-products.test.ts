// Run: node --experimental-strip-types --test src/server/handheld-products.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any -- Heterogeneous HTTP fixtures and bundled module boundaries. */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const W = "33333333-3333-4333-8333-333333333333";
const EMPTY = "44444444-4444-4444-8444-444444444444";
type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let failures: Set<string>;
let requests: string[];
let stockSkuFilters: (string | null)[];
let deviceLocation: string | null;
let rowCap: number;
let allowFixtureBrandWrite: boolean;
let detailMetadataFailure: boolean;

function sku(id: string, extra: Row = {}): Row {
  return {
    id,
    sku_code: id,
    barcode: `bar-${id}`,
    epc: `epc-${id}`,
    name: `Product ${id}`,
    category: "toy_model",
    price_tier: 29,
    grade: "A",
    image_url: null,
    image_paths: null,
    image_processing_status: "idle",
    notes: null,
    weight_g: 250,
    status: "active",
    is_display: true,
    kind: "single",
    is_custom_price: true,
    inventory_policy: "tracked",
    stock_qty: 0,
    attributes: {},
    brand_id: null,
    brand_candidate_text: null,
    ip_id: null,
    ip_candidate_text: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...extra,
  };
}

// The real Supabase client builds requests. Only its HTTP boundary is replaced;
// route authorization, filtering, totals, stock badges and pagination all execute.
function matches(value: unknown, expression: string): boolean {
  if (expression.startsWith("not.")) return !matches(value, expression.slice(4));
  const [op, ...parts] = expression.split(".");
  const raw = parts.join(".");
  if (op === "eq") return String(value) === raw;
  if (op === "gt") return Number(value) > Number(raw);
  if (op === "in") return raw.slice(1, -1).split(",").includes(String(value));
  if (op === "is") return raw === "null" ? value == null : String(value) === raw;
  if (op === "ilike") {
    const pattern = raw.replace(/^"|"$/g, "").replace(/^%|%$/g, "");
    return String(value ?? "")
      .toLowerCase()
      .includes(pattern.toLowerCase());
  }
  throw new Error(`Unsupported test filter ${expression}`);
}

const db = createClient("https://product-tests.invalid", "unit-test-only-key", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") {
        const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
        return token && ["hq", "super", "staff", "none"].includes(token)
          ? Response.json({ id: token, email: null, app_metadata: {}, user_metadata: {} })
          : Response.json({ message: "Invalid session" }, { status: 401 });
      }
      assert.equal(url.hostname, "product-tests.invalid", "tests must never contact production");
      const table = url.pathname.split("/").at(-1)!;
      assert.ok(
        ["GET", "HEAD"].includes(init?.method ?? "GET") ||
          (allowFixtureBrandWrite && init?.method === "PATCH" && table === "inv_skus"),
        "product reads must not write",
      );
      requests.push(table);
      if (table === "inv_stocks") stockSkuFilters.push(url.searchParams.get("sku_id"));
      if (
        failures.has(table) ||
        (detailMetadataFailure &&
          table === "inv_skus" &&
          url.searchParams.get("select")?.includes("attributes"))
      ) {
        return Response.json({ code: "42501", message: "query failed" }, { status: 500 });
      }
      assert.ok(tables[table], `Unexpected table ${table}`);
      let rows = tables[table].map((r) => ({ ...r }));
      if (table === "inv_handheld_devices") {
        rows[0].location = tables.inv_locations.find((l) => l.id === deviceLocation) ?? null;
      }
      if (table === "inv_stocks" && url.searchParams.get("select")?.includes("location:")) {
        rows = rows.map((row) => ({
          ...row,
          location: tables.inv_locations.find((l) => l.id === row.location_id) ?? null,
        }));
      }
      for (const [key, value] of url.searchParams) {
        if (["select", "order", "offset", "limit"].includes(key)) continue;
        if (key === "or") {
          rows = rows.filter((row) =>
            value
              .slice(1, -1)
              .split(",")
              .some((condition) => {
                const dot = condition.indexOf(".");
                return matches(row[condition.slice(0, dot)], condition.slice(dot + 1));
              }),
          );
        } else {
          rows = rows.filter((row) => matches(row[key], value));
        }
      }
      const count = rows.length;
      if (init?.method === "PATCH") {
        for (const row of rows) {
          Object.assign(
            tables[table].find((saved) => saved.id === row.id)!,
            JSON.parse(String(init.body)),
          );
        }
        return new Response(null, { status: 204 });
      }
      const order = (url.searchParams.get("order") ?? "").split(",").filter(Boolean);
      rows.sort((a, b) => {
        for (const field of order) {
          const [column, dir] = field.split(".");
          const cmp = String(a[column]).localeCompare(String(b[column]));
          if (cmp) return dir === "desc" ? -cmp : cmp;
        }
        return 0;
      });
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Math.min(rowCap, Number(url.searchParams.get("limit") ?? rowCap));
      rows = rows.slice(offset, offset + limit);
      if (table === "inv_skus") {
        const columns = url.searchParams
          .get("select")!
          .split(",")
          .map((column) => column.trim());
        rows = rows.map((row) =>
          Object.fromEntries(columns.map((column) => [column, row[column]])),
        );
      }
      const headers = { "content-range": `${offset}-${offset + rows.length - 1}/${count}` };
      return init?.method === "HEAD"
        ? new Response(null, { headers })
        : Response.json(rows, { headers });
    },
  },
});
(globalThis as any).__productTestDb = db;

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundled = await build({
  stdin: {
    contents: `export { Route as list } from './src/routes/api/public/handheld/products.ts';
      export { Route as lookup } from './src/routes/api/public/handheld/products.lookup.ts';
      export { Route as detail } from './src/routes/api/public/handheld/items.$id.ts';
      export { persistSmartCreateBrand } from './src/server/handheld-smart-create.server.ts';`,
    resolveDir: root,
    loader: "ts",
  },
  absWorkingDir: root,
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "product-route-boundaries",
      setup(builder: any) {
        builder.onResolve(
          { filter: /^@tanstack\/react-router$|client\.server$|sku-image-resolver\.server$/ },
          (args: any) => ({
            path: args.path,
            namespace: "test-boundary",
          }),
        );
        builder.onLoad({ filter: /.*/, namespace: "test-boundary" }, (args: any) => ({
          contents:
            args.path === "@tanstack/react-router"
              ? "export const createFileRoute = () => (options) => options;"
              : args.path.endsWith("client.server")
                ? "export const supabaseAdmin = globalThis.__productTestDb;"
                : "export const signSkuImagePaths = async paths => paths.map(p => 'https://images.invalid/' + p);",
        }));
      },
    },
  ],
});
const routes = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

beforeEach(() => {
  failures = new Set();
  requests = [];
  stockSkuFilters = [];
  deviceLocation = A;
  rowCap = 1000;
  allowFixtureBrandWrite = false;
  detailMetadataFailure = false;
  tables = {
    inv_handheld_devices: [{ id: "device", token: "device", is_active: true, device_code: "test" }],
    user_roles: [
      { user_id: "hq", role: "hq_operator" },
      { user_id: "super", role: "super_admin" },
      { user_id: "staff", role: "shop_staff" },
    ],
    user_location_perms: [A, B, EMPTY].map((location_id) => ({ user_id: "staff", location_id })),
    inv_locations: [
      { id: A, name: "A", kind: "shop", shop_id: "shop-a", is_active: true },
      { id: B, name: "B", kind: "shop", shop_id: "shop-b", is_active: true },
      { id: W, name: "Warehouse", kind: "warehouse", shop_id: null, is_active: true },
      { id: EMPTY, name: "Empty", kind: "shop", shop_id: "empty", is_active: true },
    ],
    youzan_shops: [
      { id: "shop-a", store_format: "vintage" },
      { id: "shop-b", store_format: "other" },
    ],
    inv_skus: [
      sku("a"),
      sku("b"),
      sku("sold-a"),
      sku("sold-b"),
      sku("down-a", { is_display: false }),
      sku("down-b", { is_display: false }),
      sku("bundle-a", { kind: "bundle" }),
      sku("bundle-b", { kind: "bundle" }),
      sku("standard", { is_custom_price: false, inventory_policy: "unlimited" }),
      sku("orphan"),
      sku("warehouse"),
    ],
    inv_stocks: [
      { sku_id: "a", location_id: A, qty: 2 },
      { sku_id: "b", location_id: B, qty: 5 },
      { sku_id: "sold-a", location_id: A, qty: 0 },
      { sku_id: "sold-b", location_id: B, qty: 0 },
      { sku_id: "down-a", location_id: A, qty: 1 },
      { sku_id: "down-b", location_id: B, qty: 1 },
      { sku_id: "bundle-a", location_id: A, qty: 2 },
      { sku_id: "bundle-b", location_id: B, qty: 2 },
      { sku_id: "warehouse", location_id: W, qty: 3 },
    ],
    inv_sku_facets: [
      {
        sku_id: "a",
        source: "manual",
        facet: { code: "ceramic", name: "Ceramic", dimension: "material" },
      },
      { sku_id: "a", source: "ai", facet: { code: "retro", name: "Retro", dimension: "style" } },
      {
        sku_id: "b",
        source: "manual",
        facet: { code: "other", name: "Other", dimension: "style" },
      },
    ],
    inv_brands: [
      {
        id: "nike",
        name: "Nike",
        name_original: null,
        aliases: ["耐克"],
        entity_type: "brand",
        status: "active",
      },
      {
        id: "sanrio-parent",
        name: "三丽鸥 (Sanrio)",
        name_original: "Sanrio",
        aliases: ["三丽鸥"],
        entity_type: "ip",
        status: "active",
      },
      {
        id: "hello-kitty",
        name: "Hello Kitty",
        name_original: null,
        aliases: ["凯蒂猫"],
        entity_type: "ip",
        status: "active",
      },
    ],
  };
});

async function call(
  route = "list",
  params = `location_id=${A}`,
  session: string | null = "hq",
  itemId = "a",
) {
  const headers: Record<string, string> = { "x-device-token": "device" };
  if (session) headers["x-session-token"] = session;
  const response = await routes[route].server.handlers.GET({
    request: new Request(`https://api.invalid/products?${params}`, { headers }),
    params: { id: itemId },
  });
  return { status: response.status, body: await response.json() };
}
function ids(body: Row): string[] {
  return body.data.items.map((it: Row) => it.id).sort();
}

for (const route of ["list", "lookup", "detail"]) {
  test(`${route}: legacy authorized is a single-location alias even for HQ`, async () => {
    const { status, body } = await call(route, "scope=authorized&code=bar-a");
    assert.equal(status, 200);
    assert.equal(body.data.scope, `location:${A}`);
    if (route === "list") assert.ok(!ids(body).includes("b"));
    const selected = await call(
      route,
      `scope=authorized&location_id=${B}&code=bar-b`,
      "staff",
      "b",
    );
    assert.equal(selected.status, 200);
    assert.equal(selected.body.data.scope, `location:${B}`);
  });
  for (const session of [null, "expired"]) {
    test(`${route}: missing/invalid employee session ${session} is denied before product reads`, async () => {
      const { status } = await call(route, `location_id=${A}&code=bar-a`, session);
      assert.equal(status, 401);
      assert.ok(!requests.includes("inv_skus"));
    });
  }
  test(`${route}: only an explicit HQ all request may use all scope`, async () => {
    const denied = await call(route, "scope=all&code=bar-b", "staff", "b");
    assert.equal(denied.status, 403);
    const accepted = await call(route, "scope=all&code=bar-b", "hq", "b");
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.scope, "all");
  });
  test(`${route}: selected location overrides a stale device location`, async () => {
    const { status, body } = await call(
      route,
      `scope=current_location&location_id=${B}&code=bar-b`,
      "staff",
      "b",
    );
    assert.equal(status, 200);
    assert.equal(body.data.scope, `location:${B}`);
    if (route !== "list") assert.equal(body.data.id, "b");
    else assert.deepEqual(ids(body), ["b", "bundle-b", "down-b", "sold-b"]);
  });
  test(`${route}: legacy current_location falls back to the authorized device`, async () => {
    const { status, body } = await call(route, "scope=current_location&code=bar-a", "staff");
    assert.equal(status, 200);
    assert.equal(body.data.scope, `location:${A}`);
  });
  for (const params of [
    "",
    "scope=authorized",
    "scope=invalid",
    "scope=current_location",
    `scope=all&location_id=${A}`,
  ]) {
    test(`${route}: ambiguous/missing scope fails closed (${params || "omitted"})`, async () => {
      deviceLocation = null;
      const { status } = await call(route, `${params}&code=bar-a`);
      assert.equal(status, 400);
    });
  }
  test(`${route}: no permission or inactive location never exposes a product`, async () => {
    assert.equal((await call(route, `location_id=${A}&code=bar-a`, "none")).status, 403);
    tables.inv_locations[0].is_active = false;
    assert.equal((await call(route, `location_id=${A}&code=bar-a`)).status, 403);
  });
  for (const table of [
    "user_roles",
    "user_location_perms",
    "inv_locations",
    "inv_stocks",
    "youzan_shops",
    "inv_skus",
  ]) {
    test(`${route}: ${table} failure is not an empty success or a broader fallback`, async () => {
      failures.add(table);
      const { status, body } = await call(route, `location_id=${A}&code=bar-a`, "staff");
      assert.equal(status, 500);
      assert.equal(body.ok, false);
    });
  }
}

test("HQ selected store isolates custom/bundle membership even at zero quantity", async () => {
  const { body } = await call();
  assert.deepEqual(ids(body), ["a", "bundle-a", "down-a", "sold-a", "standard"]);
  assert.deepEqual(body.data.counts, { custom: 3, bundle: 1, standard: 1, all: 5 });
});
test("authorization uses bounded role-existence and permission lookups without empty-page probes", async () => {
  const result = await call("list", `location_id=${A}`, "staff");
  assert.equal(result.status, 200);
  assert.equal(requests.filter((table) => table === "user_roles").length, 1);
  assert.equal(requests.filter((table) => table === "user_location_perms").length, 1);
});
test("the same SKU derives stock, history badges and counts from the selected location", async () => {
  tables.inv_stocks.push({ sku_id: "sold-a", location_id: B, qty: 5 });
  const a = await call("lookup", `location_id=${A}&code=bar-sold-a`);
  const b = await call("lookup", `location_id=${B}&code=bar-sold-a`);
  assert.equal(a.body.data.total_stock_qty, 0);
  assert.equal(a.body.data.listing_status, "sold_out");
  assert.equal(a.body.data.can_restock, true);
  assert.equal(b.body.data.total_stock_qty, 5);
  assert.equal(b.body.data.listing_status, "selling");
  assert.equal(b.body.data.can_restock, false);
  assert.deepEqual(
    a.body.data.stocks.map((stock: Row) => stock.location_id),
    [A],
  );
  assert.deepEqual(
    b.body.data.stocks.map((stock: Row) => stock.location_id),
    [B],
  );
});
test("list and lookup preserve persisted image-processing state and signed image order", async () => {
  Object.assign(
    tables.inv_skus.find((s) => s.id === "a")!,
    {
      image_processing_status: "processing",
      image_paths: ["front.jpg", "side.jpg"],
    },
  );
  const list = await call("list", `location_id=${A}&q=Product a`);
  const lookup = await call("lookup", `location_id=${A}&code=bar-a`);
  for (const item of [list.body.data.items[0], lookup.body.data]) {
    assert.equal(item.image_processing_status, "processing");
    assert.deepEqual(
      item.images.map((image: Row) => image.storage_path),
      ["front.jpg", "side.jpg"],
    );
    assert.equal(item.image_url, "https://images.invalid/front.jpg");
  }
});
for (const [status, expected] of [
  ["sold_out", ["sold-a"]],
  ["in_warehouse", ["down-a"]],
  ["selling", ["a", "bundle-a", "standard"]],
] as const) {
  test(`${status} history and counts remain in the selected location`, async () => {
    const { body } = await call("list", `location_id=${A}&status=${status}`, "staff");
    assert.deepEqual(ids(body), expected);
    assert.equal(body.data.counts.all, expected.length);
  });
}
test("type-independent counts use the same status, category, search and image filters", async () => {
  tables.inv_skus.find((s) => s.id === "a")!.image_paths = ["a.jpg"];
  const { body } = await call(
    "list",
    `location_id=${A}&type=custom&status=selling&has_image=1&q=Product&category=toy_model`,
  );
  assert.deepEqual(ids(body), ["a"]);
  assert.deepEqual(body.data.counts, { custom: 1, bundle: 1, standard: 1, all: 3 });
});
test("empty and overflow pages keep the verified scope and unpaged counts", async () => {
  const empty = await call("list", `location_id=${EMPTY}`);
  assert.equal(empty.body.data.scope, `location:${EMPTY}`);
  assert.deepEqual(ids(empty.body), []);
  assert.deepEqual(empty.body.data.counts, { custom: 0, bundle: 0, standard: 0, all: 0 });
  const overflow = await call("list", `location_id=${A}&page=999`);
  assert.equal(overflow.body.data.scope, `location:${A}`);
  assert.equal(overflow.body.data.total, 5);
  assert.equal(overflow.body.data.counts.all, 5);
  assert.deepEqual(ids(overflow.body), []);
});
test("HQ all includes unassigned products but does not double-count a SKU cache as warehouse stock", async () => {
  const { body } = await call("list", "scope=all");
  assert.ok(ids(body).includes("orphan"));
  assert.equal(body.data.items.find((it: Row) => it.id === "a").total_stock_qty, 2);
  assert.equal(body.data.items.find((it: Row) => it.id === "warehouse").total_stock_qty, 3);
});
test("warehouse scope uses its own inv_stocks and cannot see shop-only products", async () => {
  const { body } = await call("list", `location_id=${W}`);
  assert.deepEqual(ids(body), ["warehouse"]);
  assert.equal(body.data.items[0].stocks[0].stock_qty, 3);
});
test("legacy warehouse-only cache is used once only when the warehouse is unambiguous", async () => {
  tables.inv_skus.push(sku("legacy-warehouse", { stock_qty: 7 }));
  const warehouse = await call("list", `location_id=${W}`);
  assert.deepEqual(ids(warehouse.body), ["legacy-warehouse", "warehouse"]);
  assert.equal(
    warehouse.body.data.items.find((it: Row) => it.id === "legacy-warehouse").total_stock_qty,
    7,
  );
  assert.ok(!ids((await call()).body).includes("legacy-warehouse"));
  const all = await call("list", "scope=all");
  assert.equal(
    all.body.data.items.find((it: Row) => it.id === "legacy-warehouse").total_stock_qty,
    7,
  );
});
test("a real warehouse row including zero is authoritative over stale legacy cache", async () => {
  tables.inv_skus.find((s) => s.id === "warehouse")!.stock_qty = 999;
  tables.inv_stocks.find((s) => s.sku_id === "warehouse")!.qty = 0;
  const { body } = await call("lookup", `location_id=${W}&code=bar-warehouse`);
  assert.equal(body.data.total_stock_qty, 0);
  assert.equal(body.data.listing_status, "sold_out");
});
test("multiple warehouses never assign the combined legacy cache to the first or selected warehouse", async () => {
  tables.inv_locations.push({
    id: "55555555-5555-4555-8555-555555555555",
    name: "Other warehouse",
    kind: "warehouse",
    is_active: true,
  });
  tables.inv_skus.push(sku("ambiguous-legacy", { stock_qty: 7 }));
  assert.ok(!ids((await call("list", `location_id=${W}`)).body).includes("ambiguous-legacy"));
});
test("lookup has list-equivalent badges and never returns another location's product", async () => {
  for (const code of ["bar-b", "b", "epc-b"]) {
    assert.equal((await call("lookup", `location_id=${A}&code=${code}`)).status, 404);
  }
  const { body } = await call("lookup", `location_id=${A}&code=bar-sold-a`);
  assert.equal(body.data.scope, `location:${A}`);
  assert.equal(body.data.total_stock_qty, 0);
  assert.equal(body.data.listing_status, "sold_out");
  assert.equal(body.data.can_restock, true);
});
test("lookup keyword selects the first accessible match, not a global first match", async () => {
  tables.inv_skus.find((s) => s.id === "b")!.updated_at = "2026-09-07T00:00:00Z";
  tables.inv_skus.find((s) => s.id === "a")!.updated_at = "2026-09-06T00:00:00Z";
  const { body } = await call("lookup", `location_id=${A}&q=Product`);
  assert.equal(body.data.id, "a");
});
test("global standard catalog is allowed only for vintage stores, not custom or archived standards", async () => {
  tables.inv_skus.push(sku("archived-standard", { is_custom_price: false, status: "archived" }));
  const vintage = await call("lookup", `location_id=${A}&code=bar-standard`);
  assert.equal(vintage.status, 200);
  assert.equal(vintage.body.data.listing_status, "selling");
  assert.equal((await call("lookup", `location_id=${B}&code=bar-standard`)).status, 404);
  assert.equal((await call("lookup", `location_id=${A}&code=bar-archived-standard`)).status, 404);
});
test("products and membership beyond the database page cap are not silently dropped from totals", async () => {
  tables.inv_skus = Array.from({ length: 2105 }, (_, i) =>
    sku(`large-${String(i).padStart(4, "0")}`),
  );
  tables.inv_stocks = tables.inv_skus.map((s) => ({ sku_id: s.id, location_id: B, qty: 0 }));
  const { body } = await call("list", `location_id=${B}&status=sold_out&page=43&page_size=50`);
  assert.equal(body.data.total, 2105);
  assert.equal(body.data.counts.custom, 2105);
  assert.equal(body.data.items.length, 5);
});

for (const id of ["b", "sold-b", "down-b", "orphan", "missing"]) {
  test(`detail: inaccessible or missing SKU ${id} is indistinguishable and hides facets`, async () => {
    const { status, body } = await call("detail", `location_id=${A}`, "hq", id);
    assert.equal(status, 404);
    assert.equal(body.code, "not_found");
    assert.equal(body.data, undefined);
    assert.ok(!requests.includes("inv_sku_facets"));
  });
}

test("detail: inventory reads target one SKU without losing current, all, vintage or legacy membership", async () => {
  tables.inv_skus.push(sku("legacy-warehouse", { stock_qty: 7 }));
  for (const [params, id, qty] of [
    [`location_id=${A}`, "a", 2],
    ["scope=all", "a", 2],
    [`location_id=${A}`, "standard", 0],
    [`location_id=${W}`, "legacy-warehouse", 7],
  ] as const) {
    stockSkuFilters = [];
    const { status, body } = await call("detail", params, "hq", id);
    assert.equal(status, 200);
    assert.equal(body.data.total_stock_qty, qty);
    assert.ok(stockSkuFilters.length > 0);
    assert.ok(stockSkuFilters.every((filter) => filter === `eq.${id}`));
  }
});

test("detail: an unassigned zero-cache product never becomes an HQ product", async () => {
  const warehouse = await call("detail", `location_id=${W}`, "hq", "orphan");
  assert.equal(warehouse.status, 404);
  const all = await call("detail", "scope=all", "hq", "orphan");
  assert.equal(all.status, 200);
  assert.equal(all.body.data.scope, "all");
  assert.deepEqual(all.body.data.stocks, []);
  assert.equal(all.body.data.stock_qty, 0);
  assert.equal(all.body.data.total_stock_qty, 0);
});

test("detail: current stock, history and badges ignore other stores and the warehouse cache", async () => {
  tables.inv_stocks.push({ sku_id: "sold-a", location_id: B, qty: 5 });
  tables.inv_stocks.push({ sku_id: "sold-a", location_id: W, qty: 3 });
  tables.inv_skus.find((s) => s.id === "sold-a")!.stock_qty = 999;
  for (const [location, quantity, listingStatus, label] of [
    [A, 0, "sold_out", "已售罄"],
    [B, 5, "selling", "销售中"],
    [W, 3, "selling", "销售中"],
  ] as const) {
    const { status, body } = await call("detail", `location_id=${location}`, "hq", "sold-a");
    assert.equal(status, 200);
    assert.equal(body.data.scope, `location:${location}`);
    assert.equal(body.data.stock_qty, quantity);
    assert.equal(body.data.total_stock_qty, quantity);
    assert.equal(body.data.listing_status, listingStatus);
    assert.equal(body.data.status_label, label);
    assert.equal(body.data.can_restock, quantity === 0);
    assert.deepEqual(
      body.data.stocks.map((s: Row) => [s.location_id, s.qty]),
      [[location, quantity]],
    );
  }
  const all = await call("detail", "scope=all", "hq", "sold-a");
  assert.equal(all.body.data.stock_qty, 8);
  assert.equal(all.body.data.total_stock_qty, 8);
  assert.equal(all.body.data.stocks.length, 3);
});

test("detail: downlisted history stays in its location and is not restockable", async () => {
  const { status, body } = await call("detail", `location_id=${A}`, "staff", "down-a");
  assert.equal(status, 200);
  assert.equal(body.data.scope, `location:${A}`);
  assert.equal(body.data.is_display, false);
  assert.equal(body.data.listing_status, "in_warehouse");
  assert.equal(body.data.status_label, "仓库中");
  assert.equal(body.data.can_restock, false);
});

test("detail: vintage unlimited standard catalog stays available with correct badges", async () => {
  const { status, body } = await call("detail", `location_id=${A}`, "staff", "standard");
  assert.equal(status, 200);
  assert.equal(body.data.editable, false);
  assert.equal(body.data.product_type, "standard");
  assert.equal(body.data.is_unlimited_stock, true);
  assert.equal(body.data.listing_status, "selling");
  assert.equal(body.data.can_restock, false);
  assert.equal(body.data.total_stock_qty, 0);
  assert.equal((await call("detail", `location_id=${B}`, "staff", "standard")).status, 404);
});

test("detail: preserves every existing identity, price, label, image and print field", async () => {
  Object.assign(
    tables.inv_skus.find((s) => s.id === "a")!,
    {
      image_paths: ["front.jpg", "side.jpg"],
      image_processing_status: "processing",
      notes: "Original note",
    },
  );
  const { status, body } = await call("detail", `location_id=${A}`, "staff");
  assert.equal(status, 200);
  const data = { ...body.data };
  for (const key of [
    "scope",
    "stocks",
    "stock_qty",
    "total_stock_qty",
    "listing_status",
    "status_label",
    "can_restock",
    "product_type",
    "editable",
    "is_unlimited_stock",
    "attributes",
    "brand",
    "era",
    "brand_id",
    "brand_candidate_text",
    "ip_id",
    "ip_candidate_text",
    "ip_name",
  ])
    delete data[key];
  assert.deepEqual(data, {
    id: "a",
    sku_code: "a",
    barcode: "bar-a",
    epc: "epc-a",
    name: "Product a",
    category: "toy_model",
    facet_codes: ["ceramic", "retro"],
    tags: ["Ceramic", "Retro"],
    facets: [
      { code: "ceramic", name: "Ceramic", dimension: "material", source: "manual" },
      { code: "retro", name: "Retro", dimension: "style", source: "ai" },
    ],
    price_tier: 29,
    is_custom_price: true,
    condition_grade: "A",
    grade: "A",
    image_url: "https://images.invalid/front.jpg",
    image_paths: ["front.jpg", "side.jpg"],
    images: [
      { storage_path: "front.jpg", read_url: "https://images.invalid/front.jpg" },
      { storage_path: "side.jpg", read_url: "https://images.invalid/side.jpg" },
    ],
    image_processing_status: "processing",
    notes: "Original note",
    weight_g: 250,
    status: "active",
    is_display: true,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    print_payload: {
      sku_code: "a",
      barcode: "bar-a",
      title_short: "Product a",
      price_tag: "¥29",
      grade: "A",
    },
  });
});

test("detail: a facet query failure cannot return a successful incomplete detail", async () => {
  failures.add("inv_sku_facets");
  const { status, body } = await call("detail");
  assert.equal(status, 500);
  assert.equal(body.ok, false);
});

for (const brand of ["Nike", "Manual Brand", null]) {
  test(`detail: reads back the real brand writer's saved ${JSON.stringify(brand)} and retains era/IP`, async () => {
    Object.assign(
      tables.inv_skus.find((s) => s.id === "a")!,
      {
        attributes: { brand: "三丽鸥 (Sanrio)", era: "1990s", material: ["plastic"] },
        brand_id: "sanrio-parent",
        ip_id: "hello-kitty",
        ip_candidate_text: null,
      },
    );
    // Only this explicitly invoked writer may mutate the in-memory fixture.
    // The detail handler runs after writes are disabled again.
    allowFixtureBrandWrite = true;
    try {
      await routes.persistSmartCreateBrand({ skuId: "a", brand });
    } finally {
      allowFixtureBrandWrite = false;
    }
    assert.equal(tables.inv_skus.find((s) => s.id === "a")!.attributes.brand, brand);
    const { status, body } = await call("detail", `location_id=${A}`, "staff");
    assert.equal(status, 200);
    assert.equal(body.data.brand, brand);
    assert.deepEqual(body.data.attributes, { brand, era: "1990s", material: ["plastic"] });
    assert.equal(body.data.era, "1990s");
    assert.equal(body.data.brand_id, brand === "Nike" ? "nike" : null);
    assert.equal(body.data.brand_candidate_text, brand === "Manual Brand" ? brand : null);
    assert.equal(body.data.ip_id, "hello-kitty");
    assert.equal(body.data.ip_name, "Hello Kitty");
    assert.equal(body.data.product_type, "custom");
    assert.equal(body.data.editable, true);
    assert.equal(body.data.is_unlimited_stock, false);
  });
}

test("detail: canonical persisted IP identity wins over stale candidate text and brand", async () => {
  Object.assign(
    tables.inv_skus.find((s) => s.id === "a")!,
    {
      attributes: { brand: "Sanrio", era: null },
      ip_id: "hello-kitty",
      ip_candidate_text: "Old candidate",
    },
  );
  const { body } = await call("detail");
  assert.equal(body.data.ip_name, "Hello Kitty");
  assert.equal(body.data.era, null);
});

test("detail: unknown IP preserves its saved candidate but never invents an identity or era", async () => {
  Object.assign(
    tables.inv_skus.find((s) => s.id === "a")!,
    {
      attributes: { brand: null },
      ip_id: null,
      ip_candidate_text: "Unmatched character",
    },
  );
  const { body } = await call("detail");
  assert.equal(body.data.ip_name, "Unmatched character");
  assert.equal(body.data.ip_id, null);
  assert.equal(body.data.era, null);
});

test("detail: a brand taxonomy row cannot masquerade as an IP", async () => {
  tables.inv_skus.find((s) => s.id === "a")!.ip_id = "nike";
  const { body } = await call("detail");
  assert.equal(body.data.ip_name, null);
});

test("detail: IP lookup failure fails closed instead of returning empty metadata", async () => {
  tables.inv_skus.find((s) => s.id === "a")!.ip_id = "hello-kitty";
  failures.add("inv_brands");
  assert.equal((await call("detail")).status, 500);
});

test("detail: persisted attribute read failure fails closed", async () => {
  detailMetadataFailure = true;
  assert.equal((await call("detail")).status, 500);
});
