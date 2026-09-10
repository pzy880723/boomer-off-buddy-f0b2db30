import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadShopSkuIdSources, unwrapRead } from "./shop-sku-sources";

type Result = { data: unknown; error: { message: string } | null };

/** 假 supabase 查询链：按表名返回预设结果，任意 eq/select/limit 都返回自身 */
function fakeClient(results: Record<string, Result>) {
  const seen: string[] = [];
  const make = (table: string) => {
    const result = results[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {
      then: (resolve: (r: Result) => unknown) => Promise.resolve(result).then(resolve),
      maybeSingle: async () => result,
    };
    for (const method of ["select", "eq", "limit", "order", "or", "in"]) {
      builder[method] = () => builder;
    }
    return builder;
  };
  return {
    seen,
    from: (table: string) => {
      seen.push(table);
      return make(table);
    },
  };
}

const LOC = { data: { id: "loc-1", name: "温州" }, error: null };
const SHOP = { data: { store_format: "vintage" }, error: null };

function baseResults(): Record<string, Result> {
  return {
    inv_locations: LOC,
    youzan_shops: SHOP,
    inv_stocks: { data: [{ sku_id: "s1", qty: 3 }], error: null },
    sku_youzan_links: { data: [{ sku_id: "s2" }], error: null },
    inv_stock_movements: { data: [{ sku_id: "s3" }], error: null },
    inv_skus: { data: [{ id: "std1" }, { id: "std2" }], error: null },
  };
}

test("正常情况下合并库存/映射/流水/全局标准商品四个来源", async () => {
  const sb = fakeClient(baseResults());
  const out = await loadShopSkuIdSources(sb, "shop-1");
  assert.equal(out.location_id, "loc-1");
  assert.equal(out.store_format, "vintage");
  assert.deepEqual(out.skuIds.sort(), ["s1", "s2", "s3", "std1", "std2"]);
});

test("inv_locations 读取失败（401）必须抛错，不能返回空列表", async () => {
  const results = baseResults();
  results["inv_locations"] = { data: null, error: { message: "JWT expired" } };
  await assert.rejects(() => loadShopSkuIdSources(fakeClient(results), "shop-1"), /门店库位/);
});

test("youzan_shops 读取失败必须抛错", async () => {
  const results = baseResults();
  results["youzan_shops"] = { data: null, error: { message: "permission denied" } };
  await assert.rejects(() => loadShopSkuIdSources(fakeClient(results), "shop-1"), /门店资料/);
});

test("sku_youzan_links 读取失败必须抛错，不能少行", async () => {
  const results = baseResults();
  results["sku_youzan_links"] = { data: null, error: { message: "timeout" } };
  await assert.rejects(() => loadShopSkuIdSources(fakeClient(results), "shop-1"), /门店有赞映射/);
});

test("inv_stock_movements 读取失败必须抛错，不能少行", async () => {
  const results = baseResults();
  results["inv_stock_movements"] = { data: null, error: { message: "timeout" } };
  await assert.rejects(() => loadShopSkuIdSources(fakeClient(results), "shop-1"), /门店库存流水/);
});

test("inv_stocks 读取失败必须抛错", async () => {
  const results = baseResults();
  results["inv_stocks"] = { data: null, error: { message: "timeout" } };
  await assert.rejects(() => loadShopSkuIdSources(fakeClient(results), "shop-1"), /门店库存/);
});

test("真正没有映射库位（无错误无行）仍返回原有空结构", async () => {
  const results = baseResults();
  results["inv_locations"] = { data: null, error: null };
  const out = await loadShopSkuIdSources(fakeClient(results), "shop-1");
  assert.deepEqual(out, {
    location_id: null,
    store_format: "vintage",
    stocks: [],
    skuIds: [],
  });
});

test("非 vintage 门店不并入全局标准商品，作用域集合不变", async () => {
  const results = baseResults();
  results["youzan_shops"] = { data: { store_format: "outlet" }, error: null };
  const out = await loadShopSkuIdSources(fakeClient(results), "shop-1");
  assert.deepEqual(out.skuIds.sort(), ["s1", "s2", "s3"]);
});

test("unwrapRead 有 error 抛出、无 error 原样返回", () => {
  assert.throws(() => unwrapRead("X", { data: null, error: { message: "bad" } }), /X 读取失败/);
  assert.deepEqual(unwrapRead("X", { data: [1], error: null }), [1]);
});
