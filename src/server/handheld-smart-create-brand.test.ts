import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const LOCATION = "11111111-1111-4111-8111-111111111111";
const AUDIT = "22222222-2222-4222-8222-222222222222";
type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let writes: Array<{ table: string; method: string; body: Row }>;
let failBrandWrite: boolean;
let failBrandLookup: boolean;
let failBrandRead: boolean;
let recorded: boolean;

// Run the real route, taxonomy matching and audit attachment, but never send HTTP.
const db = createClient("https://smart-create-tests.invalid", "unit-test-only-key", {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "smart-create-tests.invalid");
      const table = url.pathname.split("/").at(-1)!;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (failBrandRead && method === "GET" && table === "inv_skus" && url.searchParams.get("select") === "attributes") {
        return Response.json({ message: "attributes unavailable" }, { status: 500 });
      }
      if (failBrandLookup && table === "inv_brands" && url.searchParams.get("entity_type") === "eq.brand") {
        return Response.json({ message: "taxonomy unavailable" }, { status: 500 });
      }
      if (failBrandWrite && method === "PATCH" && table === "inv_skus" && body.attributes?.brand === "Nike") {
        return Response.json({ message: "brand update denied" }, { status: 403 });
      }
      if (method !== "GET") writes.push({ table, method, body: structuredClone(body) });
      if (table === "inv_apply_movement") return Response.json(1);
      assert.ok(tables[table], `Unexpected test table: ${table}`);
      assert.ok(table !== "inv_brands" || method === "GET", "must not create taxonomy identities");
      let rows = tables[table].filter((row) => [...url.searchParams].every(([key, value]) => {
        if (["select", "order"].includes(key)) return true;
        assert.ok(value.startsWith("eq."), `Unexpected filter: ${key}=${value}`);
        return String(row[key]) === value.slice(3);
      }));
      if (method === "POST") {
        const row = { id: "saved-sku", barcode: "test-barcode", ...body };
        tables[table].push(row);
        rows = [row];
      } else if (method === "PATCH") {
        rows.forEach((row) => Object.assign(row, body));
      } else if (method === "DELETE") {
        tables[table] = tables[table].filter((row) => !rows.includes(row));
        return new Response(null, { status: 204 });
      }
      const single = new Headers(init?.headers).get("accept")?.includes("vnd.pgrst.object");
      return Response.json(single ? rows[0] ?? null : rows);
    },
  },
});

const boundary = {
  db,
  authenticateDevice: async () => ({
    ok: true, device: { id: "device", device_code: "test", location_id: LOCATION },
  }),
  recordOp: async () => { recorded = true; },
};
(globalThis as any).__smartCreateBrandTest = boundary;
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundled = await build({
  entryPoints: ["src/routes/api/public/handheld/items.smart-create.ts"],
  absWorkingDir: root,
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "smart-create-test-boundaries",
    setup(builder: any) {
      const modules: Record<string, string> = {
        "@tanstack/react-router": "export const createFileRoute = () => options => options;",
        "@/integrations/supabase/client.server": "export const supabaseAdmin = globalThis.__smartCreateBrandTest.db;",
        "@/server/handheld-auth.server": `
          export const HANDHELD_CORS = {};
          export const authenticateDevice = globalThis.__smartCreateBrandTest.authenticateDevice;
          export const resolveSessionUser = async () => null;
          export const ok = data => Response.json({ ok: true, data });
          export const err = (error, status = 500) => Response.json({ ok: false, error }, { status });`,
        "@/server/handheld-idempotency.server": `
          export const replayIfPresent = async () => null;
          export const recordOp = globalThis.__smartCreateBrandTest.recordOp;
          export const jsonReplay = value => Response.json(value);`,
        "@/server/handheld-listing-image-jobs.server": `
          export const enqueueListingImageJobs = async () => ({ status: "idle", queued: 0 });
          export const triggerListingImageWorker = () => {};`,
        "@/lib/youzan-offline-products.functions": "export const releaseSkuToOfflineShopsCore = () => { throw new Error('unexpected publication'); };",
        "@/lib/youzan-category-groups.server": "export const assignSkuToYouzanCategoryGroups = () => { throw new Error('unexpected publication'); };",
      };
      builder.onResolve({ filter: /.*/ }, (args: { path: string }) => modules[args.path]
        ? { path: args.path, namespace: "test-boundary" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "test-boundary" }, (args: { path: string }) => ({ contents: modules[args.path] }));
    },
  }],
});
const { Route } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

beforeEach(() => {
  writes = [];
  failBrandWrite = false;
  failBrandLookup = false;
  failBrandRead = false;
  recorded = false;
  tables = {
    inv_locations: [{ id: LOCATION, name: "Test", kind: "warehouse", is_active: true }],
    inv_categories: [
      { id: "root", code: "toy_model", name: "Toy", parent_id: null, is_active: true, kind: "category" },
      { id: "leaf", code: "toy_character_figure", name: "Figure", parent_id: "root", is_active: true, kind: "category" },
    ],
    inv_brands: [
      { id: "sanrio-parent", name: "三丽鸥 (Sanrio)", name_original: "Sanrio", aliases: ["三丽鸥"], entity_type: "ip", status: "active" },
      { id: "hello-kitty", name: "Hello Kitty", name_original: null, aliases: ["凯蒂猫"], entity_type: "ip", status: "active" },
      { id: "nike", name: "Nike", name_original: null, aliases: ["耐克"], entity_type: "brand", status: "active" },
      { id: "inactive", name: "Inactive", name_original: null, aliases: [], entity_type: "brand", status: "inactive" },
      { id: "review", name: "ReviewBrand", name_original: null, aliases: [], entity_type: "brand", status: "review" },
    ],
    inv_skus: [],
    inv_sku_facets: [],
    commerce_listings: [],
    inv_sku_classifications: [{
      id: AUDIT, category_code: "toy_character_figure",
      normalized_result: {
        attributes: { brand: "三丽鸥 (Sanrio)", era: "1990s", material: ["塑料"] },
        brand_id: "sanrio-parent", brand_match_status: "matched", brand_candidate_text: null,
        ip_id: "hello-kitty", ip_name: "Hello Kitty", ip_match_status: "matched",
        keywords: ["Hello Kitty"], attribute_confidence: { brand: 0.9 }, clarification_requests: [], facets: [],
      },
    }],
  };
});

async function create(extra: Row = {}) {
  return Route.server.handlers.POST({ request: new Request("https://route.invalid/items/smart-create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "toy_character_figure", name: "Hello Kitty item", price_tier: 69,
      is_custom_price: true, client_op_id: "test-operation", auto_push_youzan: false,
      recognition_request_id: AUDIT, ip_name: "Hello Kitty", ...extra,
    }),
  }) });
}

test("posted manual brand wins after the real recognition audit is attached", async () => {
  const response = await create({ brand: "  Nike  " });
  assert.equal(response.status, 200, await response.text());
  const sku = tables.inv_skus[0];
  assert.equal(sku.attributes.brand, "Nike");
  assert.equal(sku.brand_id, "nike");
  assert.equal(sku.brand_candidate_text, null);
  assert.equal(sku.ip_id, "hello-kitty");
  assert.equal(sku.attributes.era, "1990s");
  assert.deepEqual(sku.attributes.material, ["塑料"]);
  assert.equal(tables.inv_sku_classifications[0].sku_id, sku.id);
  assert.equal(tables.inv_sku_classifications[0].normalized_result.attributes.brand, "三丽鸥 (Sanrio)");
  assert.equal(recorded, true);
});

for (const [brand, id] of [["耐克", "nike"], ["三丽鸥", "sanrio-parent"], ["Sanrio", "sanrio-parent"]]) {
  test(`resolves posted ${brand} against current canonical taxonomy without changing the IP`, async () => {
    const response = await create({ brand });
    assert.equal(response.status, 200, await response.text());
    assert.equal(tables.inv_skus[0].attributes.brand, brand);
    assert.equal(tables.inv_skus[0].brand_id, id);
    assert.equal(tables.inv_skus[0].brand_candidate_text, null);
    assert.equal(tables.inv_skus[0].ip_id, "hello-kitty");
  });
}

for (const brand of ["New Collaboration", "Nike x Sanrio", "Inactive", "ReviewBrand", "Hello Kitty"]) {
  test(`keeps unmatched or ineligible ${brand} as candidate text, not an invented identity`, async () => {
    const response = await create({ brand });
    assert.equal(response.status, 200, await response.text());
    assert.equal(tables.inv_skus[0].attributes.brand, brand);
    assert.equal(tables.inv_skus[0].brand_id, null);
    assert.equal(tables.inv_skus[0].brand_candidate_text, brand);
  });
}

test("omitted brand leaves recognition audit metadata untouched", async () => {
  const response = await create();
  assert.equal(response.status, 200, await response.text());
  assert.equal(tables.inv_skus[0].attributes.brand, "三丽鸥 (Sanrio)");
  assert.equal(tables.inv_skus[0].brand_id, "sanrio-parent");
  assert.equal(tables.inv_skus[0].brand_candidate_text, null);
  assert.equal(writes.filter((write) => write.table === "inv_skus" && "brand_id" in write.body).length, 1);
});

for (const brand of [null, "", "   "]) {
  test(`explicit ${JSON.stringify(brand)} clears the audited brand and identity`, async () => {
    const response = await create({ brand });
    assert.equal(response.status, 200, await response.text());
    assert.equal(tables.inv_skus[0].attributes.brand, null);
    assert.equal(tables.inv_skus[0].brand_id, null);
    assert.equal(tables.inv_skus[0].brand_candidate_text, null);
    assert.equal(tables.inv_skus[0].ip_id, "hello-kitty");
  });
}

test("manual-only creation persists brand while retaining submitted attributes", async () => {
  const response = await create({ brand: "Nike", recognition_request_id: null, attributes: { material: ["布"] } });
  assert.equal(response.status, 200, await response.text());
  assert.equal(tables.inv_skus[0].brand_id, "nike");
  assert.deepEqual(tables.inv_skus[0].attributes, { material: ["布"], brand: "Nike" });
});

test("reused standard SKU persists an explicit brand even without images or recognition", async () => {
  tables.inv_skus.push({
    id: "existing", category: "toy_character_figure", name: "Hello Kitty item", price_tier: 69,
    sku_code: "existing-code", epc: "existing-epc", attributes: { colors: ["red"], brand: "Old" },
    brand_id: "old-id", brand_candidate_text: "Old",
  });
  const response = await create({ brand: "Nike", recognition_request_id: null, is_custom_price: false });
  assert.equal(response.status, 200, await response.text());
  assert.equal(tables.inv_skus.length, 1);
  assert.equal(tables.inv_skus[0].brand_id, "nike");
  assert.equal(tables.inv_skus[0].brand_candidate_text, null);
  assert.deepEqual(tables.inv_skus[0].attributes, { colors: ["red"], brand: "Nike" });
});

test("explicit clearing does not require a successful brand taxonomy lookup", async () => {
  failBrandLookup = true;
  const response = await create({ brand: null });
  assert.equal(response.status, 200, await response.text());
  assert.equal(tables.inv_skus[0].attributes.brand, null);
  assert.equal(tables.inv_skus[0].brand_id, null);
});

for (const failure of ["lookup", "read", "write"]) {
  test(`brand ${failure} failure never returns or records successful listing`, async () => {
    failBrandLookup = failure === "lookup";
    failBrandRead = failure === "read";
    failBrandWrite = failure === "write";
    const response = await create({ brand: "Nike" });
    assert.equal(response.status, 500);
    assert.equal(recorded, false);
    assert.equal(writes.some((write) => write.table === "inv_apply_movement"), false);
  });
}
