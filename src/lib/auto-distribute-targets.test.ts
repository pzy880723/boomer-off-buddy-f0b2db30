import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isStandardSharedSku,
  planAutoDistributeTargets,
} from "./auto-distribute-targets";

const SHOP_XTD = "2df58305-57c1-4792-9920-3c3aa49890bc"; // 新天地
const SHOP_MLC = "e393a259-0000-4000-8000-00000000436e"; // 美罗城（示意）
const SHOP_WZ = "17811306-0000-4000-8000-000000000001"; // 温州（示意）

const customSku = (id: string) => ({
  id,
  kind: "single",
  is_custom_price: true,
  inventory_policy: "tracked",
});
const standardSku = (id: string) => ({
  id,
  kind: "single",
  is_custom_price: false,
  inventory_policy: "unlimited",
});

test("标准品仍识别为全店共享", () => {
  assert.equal(isStandardSharedSku(standardSku("a")), true);
  assert.equal(isStandardSharedSku(customSku("b")), false);
  assert.equal(
    isStandardSharedSku({ id: "c", kind: "pack", is_custom_price: false, inventory_policy: "unlimited" }),
    false,
  );
});

test("空 default_shop_ids 的自定义品：绝不扩散到全部分店", () => {
  const plan = planAutoDistributeTargets({
    skus: [customSku("sku-1")],
    defaultShopIds: [],
    stockShopIdsBySku: new Map([["sku-1", [SHOP_XTD]]]),
  });
  assert.deepEqual(plan.customTargets.get("sku-1"), [SHOP_XTD]);
  // 关键断言：目标里不会出现没有正库存的店（新店/他店）
  assert.ok(!plan.customTargets.get("sku-1")?.includes(SHOP_MLC));
  assert.equal(plan.skippedCustomIds.length, 0);
});

test("新增门店场景：历史他店自定义品不带入新店", () => {
  // 模拟新店启用后，某历史 SKU 只在新天地有库存；
  // 即使调用方传入的库存映射里完全没有新店，结果也绝不能包含新店。
  const plan = planAutoDistributeTargets({
    skus: [customSku("old-sku")],
    defaultShopIds: [],
    stockShopIdsBySku: new Map([["old-sku", [SHOP_XTD]]]),
  });
  assert.deepEqual(plan.customTargets.get("old-sku"), [SHOP_XTD]);
});

test("空 default_shop_ids 且无任何正库存：跳过，不写有赞", () => {
  const plan = planAutoDistributeTargets({
    skus: [customSku("no-stock")],
    defaultShopIds: [],
    stockShopIdsBySku: new Map(),
  });
  assert.equal(plan.customTargets.has("no-stock"), false);
  assert.deepEqual(plan.skippedCustomIds, ["no-stock"]);
});

test("明确指定的多店 default_shop_ids 原样生效（去重）", () => {
  const plan = planAutoDistributeTargets({
    skus: [customSku("multi")],
    defaultShopIds: [SHOP_XTD, SHOP_WZ, SHOP_XTD],
    stockShopIdsBySku: new Map([["multi", [SHOP_MLC]]]),
  });
  assert.deepEqual(plan.customTargets.get("multi"), [SHOP_XTD, SHOP_WZ]);
});

test("标准品不受门店约束影响，进 standardIds", () => {
  const plan = planAutoDistributeTargets({
    skus: [standardSku("std-1"), customSku("c-1")],
    defaultShopIds: [],
    stockShopIdsBySku: new Map([["c-1", [SHOP_XTD]]]),
  });
  assert.ok(plan.standardIds.has("std-1"));
  assert.equal(plan.customTargets.has("std-1"), false);
  assert.deepEqual(plan.customTargets.get("c-1"), [SHOP_XTD]);
});

test("总部/非库存映射身份不会自动变成目标：只认传入的正库存分店", () => {
  const plan = planAutoDistributeTargets({
    skus: [customSku("hq-only")],
    defaultShopIds: [],
    stockShopIdsBySku: new Map([["hq-only", []]]),
  });
  assert.deepEqual(plan.skippedCustomIds, ["hq-only"]);
});

test("静态合同：inventory.functions 不再有“空默认→全部分店”的兜底", () => {
  const src = readFileSync("src/lib/inventory.functions.ts", "utf8");
  assert.ok(
    !src.includes('.eq("role", "branch")'),
    "autoDistributeInBackground 不得再查询全部 branch 门店作为兜底目标",
  );
  assert.match(src, /planAutoDistributeTargets/);
});
