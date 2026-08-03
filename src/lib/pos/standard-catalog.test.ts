import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addScannedProduct,
  posCartLineKey,
  posCartLineLabel,
  type PosCartLine,
  type PosScannableProduct,
} from "@/lib/pos/pos-policy";
import {
  STANDARD_CATEGORY_CODES,
  STANDARD_PRICE_TIERS,
  buildStandardCatalog,
  isSystemFallbackCategory,
} from "@/lib/pos/standard-catalog";
import { INV_CATEGORIES, PRICE_TIERS } from "@/lib/inventory.helpers";

function standard(overrides: Partial<PosScannableProduct> = {}): PosScannableProduct {
  return {
    sku_id: "11111111-1111-1111-1111-111111111111",
    product_type: "standard",
    name: "欧洲瓷器",
    unit_price: 29.9,
    available_qty: 9999,
    is_unlimited_stock: true,
    category_code: "porcelain_eu",
    category_name: "欧洲瓷器",
    subcategory_code: null,
    subcategory_name: null,
    ...overrides,
  };
}

describe("标准商品目录契约", () => {
  test("13 个业务一级类目 + 31 个价格档", () => {
    assert.equal((INV_CATEGORIES).length, 13);
    assert.equal((PRICE_TIERS).length, 31);
    assert.equal((STANDARD_CATEGORY_CODES).length, 13);
    assert.equal(STANDARD_PRICE_TIERS[0], 6.9);
    assert.equal(STANDARD_PRICE_TIERS.at(-1), 1580);
    assert.equal(STANDARD_CATEGORY_CODES).toContain("game_device");
  });

  test("系统兜底类目永不进入 POS", () => {
    assert.deepEqual(isSystemFallbackCategory("classification_pending"), true);
    assert.equal(STANDARD_CATEGORY_CODES.some(isSystemFallbackCategory), false);
  });

  test("buildStandardCatalog 按一级类目聚合子类与价格", () => {
    const groups = buildStandardCatalog(
      [
        { id: "r1", code: "game_device", name: "游戏设备", parent_id: null, is_active: true },
        {
          id: "s1",
          code: "game_handheld",
          name: "掌机",
          parent_id: "r1",
          is_active: true,
          sort_order: 1,
        },
        {
          id: "s2",
          code: "game_cartridge",
          name: "卡带",
          parent_id: "r1",
          is_active: true,
          sort_order: 2,
        },
        {
          id: "s3",
          code: "digital_game_console",
          name: "游戏机/掌机",
          parent_id: "r1",
          is_active: false,
        },
      ],
      [
        { id: "sku-b", category: "game_device", name: "游戏设备", price_tier: 99 },
        { id: "sku-a", category: "game_device", name: "游戏设备", price_tier: 6.9 },
      ],
    );
    const game = groups.find((group) => group.category_code === "game_device")!;
    assert.equal((groups).length, 13);
    assert.deepEqual(game.subcategories.map((sub) => sub.code), [
      "game_handheld",
      "game_cartridge",
    ]);
    assert.deepEqual(game.prices.map((price) => price.sku_id), ["sku-a", "sku-b"]);
  });
});

describe("POS 购物车合并键", () => {
  test("同 sku + 同二级类目合并数量", () => {
    let cart: PosCartLine[] = [];
    cart = addScannedProduct(cart, standard({ subcategory_code: "porcelain_eu_cup" }));
    cart = addScannedProduct(cart, standard({ subcategory_code: "porcelain_eu_cup" }));
    assert.equal((cart).length, 1);
    assert.equal(cart[0].quantity, 2);
  });

  test("同 sku 不同二级类目必须分行，null 与非 null 也分行", () => {
    let cart: PosCartLine[] = [];
    cart = addScannedProduct(cart, standard());
    cart = addScannedProduct(cart, standard({ subcategory_code: "porcelain_eu_cup" }));
    cart = addScannedProduct(cart, standard({ subcategory_code: "porcelain_eu_plate" }));
    assert.equal((cart).length, 3);
    assert.equal(new Set(cart.map(posCartLineKey)).size, 3);
  });

  test("展示名按是否选择二级类目切换", () => {
    assert.equal(posCartLineLabel({ name: "欧洲瓷器", subcategory_name: null }), "欧洲瓷器");
    assert.equal(posCartLineLabel({ name: "欧洲瓷器", subcategory_name: "散瓷杯碟" }), 
      "欧洲瓷器 · 散瓷杯碟",
    );
  });
});
