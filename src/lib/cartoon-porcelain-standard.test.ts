import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { INV_CATEGORIES, PRICE_TIERS } from "./inventory.helpers";

const migration = readFileSync(
  "supabase/migrations/20260826153000_cartoon_porcelain_standard_catalog.sql",
  "utf8",
);

test("卡通瓷器使用独立一级分类和完整 31 档价格", () => {
  const category = INV_CATEGORIES.find((item) => item.value === "porcelain_cartoon");
  assert.deepEqual(category, {
    value: "porcelain_cartoon",
    label: "卡通瓷器",
    code: "CP",
  });
  assert.equal(PRICE_TIERS.length, 31);
  for (const price of PRICE_TIERS) assert.match(migration, new RegExp(`\\b${price}\\b`));
});

test("卡通瓷器迁移保持一个商品组、无限库存和统一主图", () => {
  assert.match(migration, /'SKU-STD-CP'/);
  assert.match(migration, /'unlimited'/);
  assert.match(migration, /SKU-STD-CP\.jpg/);
  assert.match(migration, /ON CONFLICT \(category, price_tier, name\)/);
});
