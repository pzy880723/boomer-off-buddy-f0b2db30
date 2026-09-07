import assert from "node:assert/strict";
import { createReadOnlyFetch, expectedScope, assertItems, report, runVerification } from "./verify-handheld-product-scopes.mjs";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const W = "33333333-3333-4333-8333-333333333333";
export const fixture = {
  inv_locations: [
    { id: A, name: "上海 fixture 店", kind: "shop", shop_id: "shop-a", is_active: true },
    { id: B, name: "温州 fixture 店", kind: "shop", shop_id: "shop-b", is_active: true },
    { id: W, name: "fixture 仓库", kind: "warehouse", shop_id: null, is_active: true },
  ],
  youzan_shops: [
    { id: "shop-a", shop_name: "上海 fixture 店", address: "上海", store_format: "vintage" },
    { id: "shop-b", shop_name: "温州 fixture 店", address: "温州", store_format: "other" },
  ],
  user_roles: [
    { user_id: "fixture-shanghai-staff", role: "shop_staff" },
    { user_id: "fixture-wenzhou-staff", role: "shop_staff" },
    { user_id: "fixture-hq", role: "hq_operator" },
  ],
  user_location_perms: [
    { user_id: "fixture-shanghai-staff", location_id: A },
    { user_id: "fixture-wenzhou-staff", location_id: B },
  ],
  inv_skus: [
    { id: "a", is_custom_price: true },
    { id: "b", is_custom_price: true },
    { id: "zero", is_custom_price: true },
    { id: "shared", is_custom_price: true },
    { id: "bundle", kind: "bundle", is_custom_price: false },
    { id: "catalog", is_custom_price: false, inventory_policy: "unlimited" },
    { id: "inactive-standard", is_custom_price: false, status: "inactive" },
    { id: "orphan", is_custom_price: true },
    { id: "legacy", is_custom_price: true, stock_qty: 7 },
  ].map((row) => ({
    kind: "single", status: "active", inventory_policy: "tracked", stock_qty: 0,
    sku_code: `code-${row.id}`, barcode: `bar-${row.id}`, epc: `epc-${row.id}`,
    name: "PRIVATE_PRODUCT_SENTINEL", price_tier: 69, category: "toy_character_figure",
    image_paths: ["sku-raw/private-fixture.jpg"], image_url: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...row,
  })),
  inv_stocks: [
    { sku_id: "a", location_id: A, qty: 2 },
    { sku_id: "zero", location_id: A, qty: 0 },
    { sku_id: "shared", location_id: A, qty: 1 },
    { sku_id: "shared", location_id: B, qty: 4 },
    { sku_id: "b", location_id: B, qty: 3 },
    { sku_id: "bundle", location_id: B, qty: 0 },
  ],
  inv_categories: [
    { id: "root", code: "toy_model", name: "Toy", parent_id: null, is_active: true, kind: "category" },
    { id: "leaf", code: "toy_character_figure", name: "Figure", parent_id: "root", is_active: true, kind: "category" },
  ],
  inv_brands: [
    { id: "sanrio", name: "三丽鸥 (Sanrio)", name_original: "Sanrio", aliases: ["三丽鸥"], entity_type: "ip", status: "active" },
    { id: "kitty", name: "Hello Kitty", name_original: "ハローキティ", aliases: ["凯蒂猫"], entity_type: "ip", status: "active" },
  ],
  inv_sku_facets: [],
  inv_facets: [],
};

export async function selfTest() {
  let ok = true;
  const check = async (name, fn) => {
    try { await fn(); report("本地 fixture", name, "PASS"); }
    catch { ok = false; report("本地 fixture", name, "FAIL"); }
  };
  await check("GET_SELECT_ALLOWED", async () => {
    let calls = 0;
    const gate = createReadOnlyFetch("https://fixture.invalid", async (_input, init) => {
      calls++;
      assert.equal(init.redirect, "error");
      return Response.json([]);
    });
    assert.equal((await gate.fetch("https://fixture.invalid/rest/v1/inv_stocks?select=sku_id")).status, 200);
    assert.equal(calls, 1);
  });
  await check("WRITE_RPC_REDIRECT_FENCE", async () => {
    let calls = 0;
    const gate = createReadOnlyFetch("https://fixture.invalid", async () => { calls++; return Response.json([]); });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      assert.ok(!(await gate.fetch(new Request("https://fixture.invalid/rest/v1/inv_skus?select=id", { method }))).ok);
    }
    for (const url of [
      "https://fixture.invalid/rest/v1/rpc/unsafe?select=id",
      "https://other.invalid/rest/v1/inv_skus?select=id",
      "https://fixture.invalid/rest/v1/youzan_shops?select=access_token",
    ]) assert.ok(!(await gate.fetch(url)).ok);
    assert.equal(calls, 0);
    assert.equal(gate.state.violations, 7);
    assert.equal((await gate.fetch("https://fixture.invalid/storage/v1/object/sign/sku-raw", {
      method: "POST", body: JSON.stringify({ paths: ["item.jpg"], expiresIn: 86400 }),
    })).status, 200);
    assert.equal(gate.state.signing, 1);
    assert.equal(calls, 1);
    assert.equal((await gate.fetch("https://fixture.invalid/storage/v1/object/sku-raw", {
      method: "POST", body: "upload",
    })).status, 405);
    assert.equal((await gate.fetch("https://fixture.invalid/storage/v1/object/sign/sku-raw", {
      method: "POST", body: JSON.stringify({ paths: ["item.jpg"], expiresIn: 86400, upload: true }),
    })).status, 405);
    assert.equal(calls, 1);
  });
  await check("STOCK_MEMBERSHIP_ZERO_CATALOG_HQ", () => {
    const shanghai = expectedScope(fixture, A);
    const wenzhou = expectedScope(fixture, B);
    assert.deepEqual([...shanghai.ids].sort(), ["a", "catalog", "shared", "zero"]);
    assert.deepEqual([...wenzhou.ids].sort(), ["b", "bundle", "shared"]);
    assert.deepEqual(shanghai.counts, { all: 4, custom: 3, bundle: 0, standard: 1 });
    assert.equal(expectedScope(fixture, "all").ids.size, fixture.inv_skus.length);
    assert.deepEqual(shanghai.stocks.get("shared"), [{ location_id: A, qty: 1 }]);
  });
  await check("REJECT_FOREIGN_MEMBERSHIP_AND_QUANTITY", () => {
    const expected = expectedScope(fixture, A);
    const good = { id: "a", total_stock_qty: 2, stocks: [{ location_id: A, qty: 2 }] };
    assertItems([good], expected);
    assert.throws(() => assertItems([{ ...good, id: "b" }], expected));
    assert.throws(() => assertItems([{ ...good, total_stock_qty: 99 }], expected));
    assert.throws(() => assertItems([{ ...good, stocks: [{ location_id: B, qty: 2 }] }], expected));
  });
  return ok;
}

function fixtureTransport(data) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "fixture.invalid", "fixture transport never uses a real host");
    if (url.pathname === "/storage/v1/object/sign/sku-raw") {
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      return Response.json(body.paths.map((path) => ({ path,
        signedURL: `/object/sign/sku-raw/${path}?token=PRIVATE_SIGNED_SENTINEL`,
      })));
    }
    assert.ok(["GET", "HEAD"].includes(init.method ?? "GET"));
    const table = url.pathname.split("/").at(-1);
    assert.ok(data[table]);
    let rows = data[table].filter((row) => [...url.searchParams].every(([key, value]) => {
      if (["select", "order", "offset", "limit"].includes(key)) return true;
      if (value.startsWith("eq.")) return String(row[key]) === value.slice(3);
      if (value.startsWith("gt.")) return Number(row[key]) > Number(value.slice(3));
      if (value.startsWith("in.(")) return value.slice(4, -1).split(",").includes(String(row[key]));
      throw new Error("unsupported fixture filter");
    })).map((row) => structuredClone(row));
    rows.sort((a, b) => {
      for (const order of (url.searchParams.get("order") ?? "").split(",").filter(Boolean)) {
        const [field, dir] = order.split(".");
        const diff = String(a[field]).localeCompare(String(b[field]));
        if (diff) return dir === "desc" ? -diff : diff;
      }
      return 0;
    });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    // A small server-side cap proves both oracle and handlers exhaust pages.
    rows = rows.slice(offset, offset + Math.min(2, Number(url.searchParams.get("limit") ?? 2)));
    if (table === "inv_stocks" && url.searchParams.get("select")?.includes("location:")) {
      rows = rows.map((row) => ({ ...row, location: data.inv_locations.find((location) => location.id === row.location_id) }));
    }
    const single = new Headers(init.headers).get("accept")?.includes("vnd.pgrst.object");
    return Response.json(single ? rows[0] ?? null : rows);
  };
}

export async function fixtureIntegration() {
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = "https://fixture.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-only-key";
  try {
    report("本地 fixture", "NO_ENV_FILE_NO_REAL_NETWORK", "PASS");
    const lines = [];
    const result = await runVerification({
      transport: fixtureTransport(structuredClone(fixture)),
      output: (...args) => { lines.push(args); report(...args); },
    });
    const text = JSON.stringify(lines);
    const privateValues = ["PRIVATE_PRODUCT_SENTINEL", "PRIVATE_SIGNED_SENTINEL", "fixture-only-key",
      ...fixture.user_roles.map((row) => row.user_id), A, B, W];
    const safe = privateValues.every((value) => !text.includes(value));
    report("本地 fixture", "OUTPUT_REDACTION", safe ? "PASS" : "FAIL", lines.length);
    const hqCovered = (rows) => fixture.inv_locations.every((location) =>
      ["PRODUCTS_ALL_MEMBERSHIP_COUNTS", "LOOKUP_MEMBERSHIP_STOCK", "DETAIL_MEMBERSHIP_STOCK"].every((check) =>
        rows.some((row) => row[0] === location.name && row[1] === `HQ_CURRENT_${check}` && row[2] === "PASS")))
      && rows.some((row) => row[0] === "HQ all" && row[1] === "PRODUCTS_ALL_MEMBERSHIP_COUNTS" && row[2] === "PASS");
    const hqMatrix = hqCovered(lines) && !result.incomplete;
    report("本地 fixture", "HQ_CURRENT_SHANGHAI_WENZHOU_WAREHOUSE_AND_ALL", hqMatrix ? "PASS" : "FAIL", 4);
    const noStaff = structuredClone(fixture);
    noStaff.user_roles = noStaff.user_roles.filter((row) => row.role === "hq_operator");
    noStaff.user_location_perms = [];
    const skipped = [];
    const empty = await runVerification({ transport: fixtureTransport(noStaff), output: (...args) => skipped.push(args) });
    const optionalStaff = !empty.incomplete && empty.failed === 0 && hqCovered(skipped)
      && skipped.filter((row) => row[1] === "NO_SCOPED_EMPLOYEE" && row[2] === "SKIP").length === 2;
    report("本地 fixture", "NO_STORE_EMPLOYEE_NONBLOCKING_SKIP", optionalStaff ? "PASS" : "FAIL", 2);
    noStaff.user_roles = [];
    const missingHq = [];
    const missing = await runVerification({ transport: fixtureTransport(noStaff), output: (...args) => missingHq.push(args) });
    const noFake = missing.incomplete && missingHq.some((row) => row[1] === "NO_HQ_EMPLOYEE" && row[2] === "SKIP");
    report("本地 fixture", "NO_HQ_EMPLOYEE_INCOMPLETE", noFake ? "PASS" : "FAIL");
    return { ...result, failed: result.failed + Number(!safe) + Number(!hqMatrix) + Number(!optionalStaff) + Number(!noFake) };
  } finally {
    for (const [key, value] of Object.entries({ SUPABASE_URL: previous.url, SUPABASE_SERVICE_ROLE_KEY: previous.key })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
