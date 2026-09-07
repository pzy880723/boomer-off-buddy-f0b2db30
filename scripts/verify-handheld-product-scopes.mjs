#!/usr/bin/env node
// DEFAULT (no args): real readonly integration using this release's .env.
// Node >= 22, in a source release with its existing node_modules.
// After owner review: node scripts/verify-handheld-product-scopes.mjs
// Local fixture only: node scripts/verify-handheld-product-scopes.mjs --self-test
// Optional selectors: --shanghai-name <name> --wenzhou-name <name>.
// Readonly integration, NOT a live authenticated API test. Only registration
// and two auth entry points are replaced; permission queries remain real.
// No response bodies, employee IDs, products, credentials or signed URLs are
// logged/written. Exit: 0 passed, 1 failed, 2 missing HQ/location or data drift.
// Missing optional store employees are SKIP, not an incomplete HQ acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contextKey = "__boomerReadonlyProductVerification";
const tables = new Set([
  "inv_locations", "inv_stocks", "inv_skus", "user_roles", "user_location_perms",
  "youzan_shops", "inv_categories", "inv_brands", "inv_sku_facets", "inv_facets",
]);
const signingBuckets = new Set([
  "sku-raw", "sku-listing", "parcel-item-images",
  "domestic-order-screenshots", "domestic-bulk-attachments",
]);

export function report(store, check, status, count) {
  process.stdout.write(`${JSON.stringify({ store, check, status, ...(count === undefined ? {} : { count }) })}\n`);
}

export function createReadOnlyFetch(baseUrl, transport) {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const restPrefix = `${prefix}/rest/v1/`;
  const signPrefix = `${prefix}/storage/v1/object/sign/`;
  const state = { violations: 0, signing: 0, selects: 0 };
  return {
    state,
    fetch: async (input, init = {}) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input));
      const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
      let allowed = false;
      let signing = false;
      if (url.origin === base.origin && !url.username && !url.password) {
        if (url.pathname.startsWith(restPrefix)) {
          const table = url.pathname.slice(restPrefix.length);
          const selection = url.searchParams.get("select");
          allowed = ["GET", "HEAD"].includes(method) && tables.has(table) && !!selection
            && !/\*|token|secret|password|email|phone/i.test(selection);
        } else if (url.pathname.startsWith(signPrefix) && method === "POST" && !url.search) {
          const bucket = url.pathname.slice(signPrefix.length);
          try {
            const raw = init.body ?? (request ? await request.clone().text() : "");
            const body = JSON.parse(String(raw));
            signing = signingBuckets.has(bucket)
              && Object.keys(body).every((key) => ["paths", "expiresIn"].includes(key))
              && Number.isInteger(body.expiresIn) && body.expiresIn > 0 && body.expiresIn <= 86400
              && Array.isArray(body.paths) && body.paths.length > 0
              && body.paths.every((path) => typeof path === "string" && path.length > 0
                && !path.split("/").includes(".."));
            allowed = signing;
          } catch { /* Invalid signing bodies are denied before transport. */ }
        }
      }
      if (!allowed) {
        state.violations++;
        return Response.json({ message: "readonly verification blocked request" }, { status: 405 });
      }
      if (signing) state.signing++; else state.selects++;
      const response = await transport(input, {
        ...init, redirect: "error", signal: init.signal ?? request?.signal ?? AbortSignal.timeout(30000),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        state.violations++;
        return Response.json({ message: "readonly verification blocked redirect" }, { status: 405 });
      }
      return response;
    },
  };
}

function productType(sku) {
  return sku.kind === "bundle" ? "bundle" : sku.is_custom_price ? "custom" : "standard";
}

export function expectedScope(data, locationId) {
  const locations = data.inv_locations.filter((row) => row.is_active && (locationId === "all" || row.id === locationId));
  const locationIds = new Set(locations.map((row) => row.id));
  const memberStocks = data.inv_stocks.filter((row) => locationIds.has(row.location_id));
  const membership = new Set(memberStocks.map((row) => row.sku_id));
  const vintage = locationId !== "all" && locations.some((location) => data.youzan_shops.some(
    (shop) => shop.id === location.shop_id && shop.store_format === "vintage",
  ));
  const warehouses = data.inv_locations.filter((row) => row.kind === "warehouse");
  const legacyWarehouse = warehouses.length === 1 && locationIds.has(warehouses[0].id) ? warehouses[0].id : null;
  // Zero stock still proves membership. The store catalog exception never
  // admits custom/bundle SKUs without an inv_stocks relation.
  const skus = data.inv_skus.filter((sku) => locationId === "all" || membership.has(sku.id)
    || (vintage && sku.kind === "single" && sku.is_custom_price === false && sku.status === "active")
    || (legacyWarehouse && Number(sku.stock_qty) > 0));
  const ids = new Set(skus.map((row) => row.id));
  const stocks = new Map();
  const counts = { all: skus.length, custom: 0, bundle: 0, standard: 0 };
  for (const sku of skus) {
    counts[productType(sku)]++;
    const rows = memberStocks.filter((row) => row.sku_id === sku.id)
      .map((row) => ({ location_id: row.location_id, qty: Number(row.qty) || 0 }));
    if (legacyWarehouse && Number(sku.stock_qty) > 0 && !rows.some((row) => row.location_id === legacyWarehouse)) {
      rows.push({ location_id: legacyWarehouse, qty: Number(sku.stock_qty) });
    }
    stocks.set(sku.id, rows.sort((a, b) => a.location_id.localeCompare(b.location_id)));
  }
  return { ids, stocks, counts, skus, scope: locationId === "all" ? "all" : `location:${locationId}` };
}

export function assertItems(items, expected) {
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (const item of items) {
    assert.ok(expected.ids.has(item.id));
    assert.ok(Array.isArray(item.stocks));
    const actual = item.stocks.map((row) => ({ location_id: row.location_id, qty: Number(row.qty ?? row.stock_qty) }))
      .sort((a, b) => a.location_id.localeCompare(b.location_id));
    assert.deepEqual(actual, expected.stocks.get(item.id));
    assert.equal(item.total_stock_qty, actual.reduce((sum, row) => sum + row.qty, 0));
  }
}

async function bundleHandlers() {
  const require = createRequire(resolve(root, "package.json"));
  let build;
  try { ({ build } = require("esbuild")); }
  catch { ({ build } = createRequire(require.resolve("vite"))("esbuild")); }
  const authFile = resolve(root, "src/server/handheld-auth.server.ts");
  const result = await build({
    stdin: {
      contents: `
        export { Route as products } from './src/routes/api/public/handheld/products.ts';
        export { Route as lookup } from './src/routes/api/public/handheld/products.lookup.ts';
        export { Route as detail } from './src/routes/api/public/handheld/items.$id.ts';
        export { supabaseAdmin as db } from './src/integrations/supabase/client.server.ts';
        export { normalizeProductRecognition, findSanrioBrandCandidate } from './src/lib/product-classification.ts';
        export { loadActiveProductBrands, loadActiveProductIps, loadActiveProductCategories } from './src/server/product-classification.server.ts';`,
      resolveDir: root, loader: "ts",
    },
    absWorkingDir: root, bundle: true, write: false, platform: "node", format: "cjs",
    packages: "external", logLevel: "silent",
    plugins: [{
      name: "readonly-registration-and-auth-only",
      setup(builder) {
        builder.onResolve({ filter: /^@tanstack\/react-router$|handheld-auth\.server(?:\.ts)?$/ }, (args) => {
          if (args.namespace === "verification-boundary" && args.path === authFile) return { path: authFile };
          return { path: args.path, namespace: "verification-boundary" };
        });
        builder.onLoad({ filter: /.*/, namespace: "verification-boundary" }, (args) => ({
          contents: args.path === "@tanstack/react-router"
            ? "export const createFileRoute = () => options => options;"
            : `export * from ${JSON.stringify(authFile)};
              export const resolveSessionUser = async () => globalThis.${contextKey}.session;
              export const authenticateDevice = async () => ({ ok: true, device: globalThis.${contextKey}.device });`,
        }));
      },
    }],
  });
  const module = { exports: {} };
  const filename = resolve(root, "scripts/readonly-handlers.cjs");
  compileFunction(result.outputFiles[0].text, ["module", "exports", "require", "__filename", "__dirname"])(
    module, module.exports, require, filename, dirname(filename),
  );
  return module.exports;
}

async function readRows(db, table, selection, order) {
  const rows = [];
  for (;;) {
    let query = db.from(table).select(selection);
    for (const column of order) query = query.order(column);
    const { data, error } = await query.range(rows.length, rows.length + 499);
    assert.ok(!error && Array.isArray(data));
    if (!data.length) return rows;
    rows.push(...data);
  }
}

async function snapshot(db) {
  const data = {};
  for (const [table, selection, order] of [
    ["inv_locations", "id,name,kind,shop_id,is_active", ["id"]],
    ["youzan_shops", "id,shop_name,address,store_format", ["id"]],
    ["user_roles", "user_id,role", ["user_id", "role"]],
    ["user_location_perms", "user_id,location_id", ["user_id", "location_id"]],
    ["inv_stocks", "sku_id,location_id,qty", ["sku_id", "location_id"]],
    ["inv_skus", "id,sku_code,barcode,epc,kind,is_custom_price,status,inventory_policy,stock_qty", ["id"]],
  ]) data[table] = await readRows(db, table, selection, order);
  return data;
}

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function runVerification({ transport = globalThis.fetch, output = report, shanghaiName, wenzhouName } = {}) {
  const gate = createReadOnlyFetch(process.env.SUPABASE_URL, transport);
  const originalFetch = globalThis.fetch;
  const originalContext = globalThis[contextKey];
  const originalConsole = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((key) => [key, console[key]]));
  const records = [];
  let incomplete = false;
  let stage = "BUNDLE";
  const emit = (store, check, status, count) => records.push({ store, check, status, count });
  const check = async (store, name, fn) => {
    try { emit(store, name, "PASS", await fn()); }
    catch { emit(store, name, "FAIL"); }
  };
  globalThis.fetch = gate.fetch;
  for (const key of Object.keys(originalConsole)) console[key] = () => {};
  try {
    const api = await bundleHandlers();
    stage = "SELECT_BEFORE";
    const before = await snapshot(api.db);
    const hqIds = new Set(before.user_roles.filter((row) => ["super_admin", "hq_operator"].includes(row.role)).map((row) => row.user_id));
    const hqId = [...hqIds][0];
    const employees = new Set(before.user_roles.map((row) => row.user_id));
    const scopes = [];
    for (const [city, selector] of [["上海", shanghaiName], ["温州", wenzhouName]]) {
      const locations = before.inv_locations.filter((location) => {
        const shop = before.youzan_shops.find((row) => row.id === location.shop_id);
        const text = selector ? location.name : [location.name, shop?.shop_name, shop?.address].filter(Boolean).join(" ");
        return location.is_active && location.kind === "shop" && text.includes(selector ?? city);
      });
      if (!locations.length) { incomplete = true; emit(city, "NO_MATCHING_LOCATION", "SKIP", 0); }
      for (const location of locations) {
        if (hqId) scopes.push({ label: location.name, location, userId: hqId, id: location.id, hq: true });
        // Both tables reference existing auth.users. Never manufacture an employee.
        const employee = before.user_location_perms.find((row) => row.location_id === location.id
          && employees.has(row.user_id) && !hqIds.has(row.user_id));
        if (!employee) { emit(location.name, "NO_SCOPED_EMPLOYEE", "SKIP", 0); continue; }
        scopes.push({ label: location.name, location, userId: employee.user_id, id: location.id, hq: false });
      }
    }
    const warehouses = before.inv_locations.filter((row) => row.is_active && row.kind === "warehouse");
    if (!warehouses.length) { incomplete = true; emit("HQ warehouse", "NO_MATCHING_LOCATION", "SKIP", 0); }
    if (hqId) {
      for (const location of warehouses) scopes.push({ label: location.name, location, userId: hqId, id: location.id, hq: true });
      scopes.push({ label: "HQ all", location: warehouses[0] ?? before.inv_locations.find((row) => row.is_active), userId: hqId, id: "all", hq: true });
    } else { incomplete = true; emit("HQ all", "NO_HQ_EMPLOYEE", "SKIP", 0); }

    for (const scope of scopes) {
      const name = (check) => scope.id === "all" ? check : `${scope.hq ? "HQ" : "EMPLOYEE"}_CURRENT_${check}`;
      const scopeCheck = (checkName, fn) => check(scope.label, name(checkName), fn);
      globalThis[contextKey] = {
        session: { user_id: scope.userId, email: null },
        device: { id: "readonly-integration", device_code: "readonly-integration", location_id: scope.location?.id ?? null,
          location_kind: scope.location?.kind ?? null, location_name: scope.location?.name ?? null },
      };
      const expected = expectedScope(before, scope.id);
      const params = scope.id === "all" ? { scope: "all" } : { scope: "current_location", location_id: scope.id };
      const call = async (route, query = {}, id) => {
        const entries = Object.entries({ ...params, ...query }).filter(([, value]) => value !== undefined);
        const request = new Request(`https://readonly-handler.invalid/?${new URLSearchParams(entries)}`);
        const response = await api[route].server.handlers.GET({ request, params: { id } });
        return { status: response.status, body: await response.json() };
      };
      for (const type of ["all", "custom", "bundle", "standard"]) {
        await scopeCheck(`PRODUCTS_${type.toUpperCase()}_MEMBERSHIP_COUNTS`, async () => {
          const wanted = expected.skus.filter((sku) => type === "all" || productType(sku) === type);
          const items = [];
          for (let page = 1; page <= Math.max(1, Math.ceil(wanted.length / 100)); page++) {
            const result = await call("products", { type, page: String(page), page_size: "100" });
            assert.equal(result.status, 200);
            assert.equal(result.body.ok, true);
            const data = result.body.data;
            assert.equal(data.scope, expected.scope);
            assert.equal(data.total, wanted.length);
            assert.deepEqual(data.counts, expected.counts);
            items.push(...data.items);
          }
          assertItems(items, expected);
          assert.deepEqual(items.map((row) => row.id).sort(), wanted.map((row) => row.id).sort());
          return wanted.length;
        });
      }
      const samples = [...new Map([
        ...["custom", "bundle", "standard"].map((type) => expected.skus.find((sku) => productType(sku) === type)),
        expected.skus.find((sku) => before.inv_stocks.filter((row) => row.sku_id === sku.id).length > 1),
      ].filter(Boolean).map((sku) => [sku.id, sku])).values()];
      for (const route of ["lookup", "detail"]) {
        const eligible = samples.filter((sku) => route === "detail" || uniqueCode(sku, before.inv_skus));
        if (!eligible.length) { emit(scope.label, name(`${route.toUpperCase()}_NO_SAMPLE`), "SKIP", 0); continue; }
        await scopeCheck(`${route.toUpperCase()}_MEMBERSHIP_STOCK`, async () => {
          for (const sku of eligible) {
            const result = await call(route, route === "lookup" ? { code: uniqueCode(sku, before.inv_skus) } : {}, sku.id);
            assert.equal(result.status, 200);
            assert.equal(result.body.ok, true);
            assert.equal(result.body.data.id, sku.id);
            assert.equal(result.body.data.scope, expected.scope);
            assertItems([result.body.data], expected);
          }
          return eligible.length;
        });
      }
      if (scope.id !== "all") {
        const foreign = before.inv_skus.find((sku) => !expected.ids.has(sku.id) && uniqueCode(sku, before.inv_skus));
        if (foreign) await scopeCheck("FOREIGN_LOOKUP_DETAIL_DENIED", async () => {
          for (const route of ["lookup", "detail"]) {
            const result = await call(route, route === "lookup" ? { code: uniqueCode(foreign, before.inv_skus) } : {}, foreign.id);
            assert.ok([403, 404].includes(result.status));
            assert.ok(!result.body.data);
          }
          return 2;
        });
        const sample = before.inv_skus.find((sku) => uniqueCode(sku, before.inv_skus));
        if (sample && !scope.hq) await scopeCheck("HQ_ALL_DENIED", async () => {
          for (const route of ["products", "lookup", "detail"]) {
            const result = await call(route, { scope: "all", location_id: undefined, ...(route === "lookup" ? { code: uniqueCode(sample, before.inv_skus) } : {}) }, sample.id);
            assert.equal(result.status, 403);
          }
          return 3;
        });
      }
    }
    stage = "SELECT_AFTER";
    const after = await snapshot(api.db);
    if (digest(before) !== digest(after)) {
      incomplete = true;
      for (const row of records) if (row.status !== "SKIP") { row.status = "SKIP"; row.check = `DATA_CHANGED_${row.check}`; }
    }
    await check("taxonomy", "HELLO_KITTY_CANONICAL_BRAND_SEPARATE_IP", async () => {
      const categories = await api.loadActiveProductCategories();
      const brands = await api.loadActiveProductBrands();
      const ips = await api.loadActiveProductIps();
      const parent = api.findSanrioBrandCandidate(brands, ips);
      const character = ips.find((row) => row.name === "Hello Kitty");
      assert.ok(parent && character && parent.id !== character.id);
      const leaf = categories.find((row) => row.is_active && row.parent_id && categories.some((parent) => parent.id === row.parent_id && parent.is_active && parent.parent_id === null));
      assert.ok(leaf);
      const result = api.normalizeProductRecognition({
        category_code: leaf.code, confidence: 0.95, ip_name: "Hello Kitty",
        attributes: { brand: null }, attribute_confidence: { ip_name: 0.99 },
      }, categories, { facets: [], brands, ips });
      assert.equal(result.brand_id, parent.id);
      assert.equal(result.attributes.brand, parent.name);
      assert.equal(result.ip_id, character.id);
      assert.equal(result.ip_name, "Hello Kitty");
      return 1;
    });
  } catch { emit("readonly integration", stage, "FAIL"); }
  finally {
    globalThis.fetch = originalFetch;
    globalThis[contextKey] = originalContext;
    Object.assign(console, originalConsole);
  }
  emit("readonly integration", "DATABASE_WRITE_FENCE", gate.state.violations ? "FAIL" : "PASS", gate.state.violations);
  emit("readonly integration", "STORAGE_SIGN_READONLY_REQUESTS", "PASS", gate.state.signing);
  for (const row of records) output(row.store, row.check, row.status, row.count);
  return { failed: records.filter((row) => row.status === "FAIL").length, incomplete };
}

function uniqueCode(sku, skus) {
  return [sku.barcode, sku.sku_code, sku.epc].find((code) => typeof code === "string" && code.trim()
    && skus.filter((row) => [row.barcode, row.sku_code, row.epc].includes(code)).length === 1);
}

async function main() {
  const { values } = parseArgs({ options: {
    "self-test": { type: "boolean" }, "read-only": { type: "boolean" },
    "shanghai-name": { type: "string" }, "wenzhou-name": { type: "string" },
  } });
  assert.ok(!(values["self-test"] && values["read-only"]));
  if (values["self-test"]) {
    const { selfTest, fixtureIntegration } = await import("./verify-handheld-product-scopes.test.mjs");
    const pure = await selfTest();
    const result = await fixtureIntegration();
    process.exitCode = pure && result.failed === 0 ? 0 : 1;
    return;
  }
  Object.assign(process.env, parseEnv(readFileSync(resolve(root, ".env"), "utf8")));
  assert.ok(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  report("readonly integration", "NOT_LIVE_AUTHENTICATED_API", "PASS");
  const result = await runVerification({ shanghaiName: values["shanghai-name"], wenzhouName: values["wenzhou-name"] });
  process.exitCode = result.failed ? 1 : result.incomplete ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { report("readonly integration", "SETUP", "FAIL"); process.exitCode = 1; });
}
