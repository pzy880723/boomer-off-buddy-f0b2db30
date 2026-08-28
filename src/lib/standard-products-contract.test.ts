import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { addScannedProduct, type PosScannableProduct } from "./pos/pos-policy";

// 旧一级类目已被永久清理，现行一级类目见 INV_CATEGORIES
const LEGACY_ROOT_CATEGORIES = [
  "jp_porcelain",
  "eu_porcelain",
  "vintage_toy",
  "anime_goods",
  "media",
  "digital",
  "jewelry",
  "fashion",
  "daily",
  "antique",
] as const;

const CURRENT_ROOT_CATEGORIES = [
  "porcelain_jp",
  "porcelain_eu",
  "porcelain_cartoon",
  "toy_model",
  "character_ip_goods",
  "audio_media",
  "digital_appliance",
  "game_device",
  "home_goods",
  "stationery_publication",
  "fashion_wearable",
  "fashion_jewelry",
  "art_collectible",
  "daily_misc",
] as const;

const PRICE_TIERS = [
  6.9, 9.9, 12.9, 15.9, 19.9, 29.9, 39.9, 49.9, 59.9, 69, 79, 89, 99, 129, 159, 199, 259, 299, 359, 399,
  459, 499, 580, 680, 780, 880, 980, 1080, 1180, 1280, 1380, 1580,
] as const;

function standardCatalogMigration(): string {
  const filename = readdirSync("supabase/migrations").find((name) =>
    name.includes("vintage_standard_product_catalog"),
  );
  assert.ok(filename, "standard-product migration must exist");
  return readFileSync(`supabase/migrations/${filename}`, "utf8");
}

function standardPriceTierUpgradeMigration(): string {
  const filename = readdirSync("supabase/migrations").find((name) =>
    name.includes("add_standard_price_12_9"),
  );
  assert.ok(filename, "12.9 standard-price migration must exist");
  return readFileSync(`supabase/migrations/${filename}`, "utf8");
}

test("an unlimited standard product can be added with zero tracked stock", () => {
  const product: PosScannableProduct = {
    sku_id: "standard-jewelry-690",
    product_type: "standard",
    name: "珠宝首饰 6.9",
    unit_price: 6.9,
    available_qty: 0,
    is_unlimited_stock: true,
  };

  assert.deepEqual(addScannedProduct([], product), [{ ...product, quantity: 1 }]);
});

test("an unlimited standard product is not capped by available_qty", () => {
  const product: PosScannableProduct = {
    sku_id: "standard-jewelry-690",
    product_type: "standard",
    name: "珠宝首饰 6.9",
    unit_price: 6.9,
    available_qty: 0,
    is_unlimited_stock: true,
  };

  const once = addScannedProduct([], product);
  assert.equal(addScannedProduct(once, product)[0].quantity, 2);
});

function categoryCleanupMigration(): string {
  const filename = readdirSync("supabase/migrations").find((name) =>
    readFileSync(`supabase/migrations/${name}`, "utf8").includes("停用商品类目永久清理"),
  );
  assert.ok(filename, "inactive-category cleanup migration must exist");
  return readFileSync(`supabase/migrations/${filename}`, "utf8");
}

test("the current catalog upgrade covers all 32 price tiers", () => {
  const sql = standardPriceTierUpgradeMigration();
  for (const price of PRICE_TIERS) {
    assert.match(
      sql,
      new RegExp(`(^|[^0-9.])${String(price).replace(".", "\\.")}([^0-9.]|$)`, "m"),
    );
  }
  assert.match(sql, /tier_count\s*<>\s*32/i);
  assert.match(sql, /price_tier\s*=\s*12\.9/i);
});

test("legacy root categories are remapped and permanently deleted, never re-inserted", () => {
  const sql = categoryCleanupMigration();
  for (const category of LEGACY_ROOT_CATEGORIES) assert.match(sql, new RegExp(`'${category}'`));
  assert.match(sql, /DELETE FROM public\.inv_categories WHERE is_active = false/i);
  assert.doesNotMatch(sql, /INSERT INTO public\.inv_categories/i);
});

test("app-level category constants only carry current root categories", () => {
  const helpers = readFileSync("src/lib/inventory.helpers.ts", "utf8");
  for (const category of LEGACY_ROOT_CATEGORIES) {
    assert.doesNotMatch(helpers, new RegExp(`"${category}"`));
  }
  for (const category of CURRENT_ROOT_CATEGORIES) {
    assert.match(helpers, new RegExp(`"${category}"`));
  }
});

test("the migration makes standards unlimited and Vintage stores the default", () => {
  const sql = standardCatalogMigration();
  assert.match(sql, /inventory_policy[^\n]+unlimited/i);
  assert.match(sql, /store_format[^\n]+vintage/i);
  assert.match(sql, /sales_sku_available_qty[\s\S]+inventory_policy\s*=\s*'unlimited'/i);
});

test("shop and POS routes expose unlimited standards without a stock row", () => {
  const shopProducts = readFileSync("src/lib/shop-products.functions.ts", "utf8");
  const posProducts = readFileSync("src/routes/api/public/pos/products.ts", "utf8");
  const posLookup = readFileSync("src/routes/api/public/pos/products.lookup.ts", "utf8");
  const createShop = readFileSync("src/lib/shops.functions.ts", "utf8");

  assert.match(shopProducts, /inventory_policy/);
  assert.match(shopProducts, /store_format/);
  assert.match(posProducts, /is_unlimited_stock/);
  assert.match(posLookup, /is_unlimited_stock/);
  assert.match(createShop, /store_format:\s*"vintage"/);
});

test("the handheld global-stock matrix preserves unlimited standards for store views", () => {
  const globalStock = readFileSync("src/routes/api/public/handheld/global-stock.ts", "utf8");

  assert.match(globalStock, /inventory_policy/);
  assert.match(globalStock, /is_unlimited_stock/);
  assert.match(globalStock, /isUnlimitedStock\s*&&\s*isDisplay\s*\?\s*"selling"/);
});

test("standard Youzan products are distributed only to active Vintage branches", () => {
  const youzanSync = readFileSync("src/lib/youzan-sync.functions.ts", "utf8");

  assert.match(youzanSync, /store_format/);
  assert.match(youzanSync, /store_format[^\n]+vintage/);
});

test("14 个一级类目 × 32 档 = 448 个标准 SKU 的应用层契约", () => {
  const helpers = readFileSync("src/lib/inventory.helpers.ts", "utf8");
  assert.equal(CURRENT_ROOT_CATEGORIES.length, 14);
  assert.equal(PRICE_TIERS.length, 32);
  assert.equal(CURRENT_ROOT_CATEGORIES.length * PRICE_TIERS.length, 448);
  // 旧的游戏机叶子类目不得再出现在应用常量中
  assert.doesNotMatch(helpers, /digital_game_console/);
});

test("AI 识别提示词覆盖游戏设备四个叶子类目", () => {
  const prompt = readFileSync("src/server/product-recognition.server.ts", "utf8");
  for (const code of [
    "game_handheld",
    "game_desktop_console",
    "game_cartridge",
    "game_accessory",
  ]) {
    assert.match(prompt, new RegExp(code));
  }
  assert.match(prompt, /禁止再返回 digital_game_console/);
});

test("POS 标准目录接口与购物车合并键已落地", () => {
  const api = readFileSync("src/routes/api/public/pos/standard-catalog.ts", "utf8");
  const policy = readFileSync("src/lib/pos/pos-policy.ts", "utf8");
  const pos = readFileSync("src/routes/pos.tsx", "utf8");
  assert.match(api, /location_id/);
  assert.match(api, /locationInheritsStandardCatalog/);
  assert.match(policy, /posCartLineKey/);
  assert.match(pos, /细分类（可选）/);
});

test("瓷器产地不明确必须落到 ai_low_confidence 并要求人工核对", () => {
  const prompt = readFileSync("src/server/product-recognition.server.ts", "utf8");
  assert.doesNotMatch(prompt, /必须选 porcelain_origin_unknown/);
  assert.doesNotMatch(prompt, /porcelain_origin_unknown[；;]?\s*瓷器按/);
  assert.match(prompt, /产地无法确认时必须返回 ai_low_confidence/);
  assert.match(prompt, /人工核对/);
  assert.match(prompt, /禁止返回 porcelain_origin_unknown/);
});

test("停用叶子清理 migration 契约：active SKU 不得引用非 active 类目", () => {
  const sql = readFileSync(
    "supabase/migrations/20260803144636_86f58a65-bd81-4513-b651-c46e5d53305d.sql",
    "utf8",
  );
  assert.match(sql, /UPDATE public\.inv_skus/);
  assert.match(sql, /category = 'ai_low_confidence'/);
  assert.match(sql, /classification_status = 'fallback'/);
  assert.match(sql, /category_confidence = NULL/);
  assert.match(sql, /updated_at = now\(\)/);
  assert.match(sql, /s\.status = 'active'/);
  assert.match(sql, /c\.is_active = true/);
  assert.doesNotMatch(sql, /DELETE/i);
  assert.doesNotMatch(sql, /porcelain_jp|porcelain_eu/);
});

test("active 一级/叶子枚举不含已停用旧码", () => {
  const helpers = readFileSync("src/lib/inventory.helpers.ts", "utf8");
  assert.doesNotMatch(helpers, /porcelain_origin_unknown/);
  assert.doesNotMatch(helpers, /digital_game_console/);
});
