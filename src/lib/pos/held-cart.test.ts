import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { fromHeldCartSnapshot, toHeldCartSnapshot } from "@/lib/pos/held-cart";

const MIGRATION = "supabase/migrations/20260803143941_1c1cdd92-2ea0-434c-8aa9-12ba88463131.sql";

describe("挂单快照字段", () => {
  test("写入时输出 4 个 *_snapshot 对齐字段", () => {
    assert.deepEqual(
      toHeldCartSnapshot({
        category_code: "game_device",
        category_name: "游戏设备",
        subcategory_code: "game_handheld",
        subcategory_name: "掌机",
      }),
      {
        category_code: "game_device",
        category_name_snapshot: "游戏设备",
        subcategory_code: "game_handheld",
        subcategory_name_snapshot: "掌机",
      },
    );
  });

  test("缺失字段一律 null，不填充默认值", () => {
    assert.deepEqual(toHeldCartSnapshot({}), {
      category_code: null,
      category_name_snapshot: null,
      subcategory_code: null,
      subcategory_name_snapshot: null,
    });
  });

  test("取单以快照为准，缺失时回落到当前商品", () => {
    assert.deepEqual(
      fromHeldCartSnapshot(
        { category_code: "porcelain_eu", category_name_snapshot: "欧洲瓷器" },
        { category_code: "home_goods", category_name: "家居杂货", subcategory_name: "杯具" },
      ),
      {
        category_code: "porcelain_eu",
        category_name: "欧洲瓷器",
        subcategory_code: null,
        subcategory_name: "杯具",
      },
    );
  });
});

describe("迁移契约", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  test("13 个一级类目统一 kind='category'", () => {
    assert.match(sql, /SET kind = 'category'/);
    for (const code of [
      "porcelain_jp",
      "porcelain_eu",
      "game_device",
      "home_goods",
      "toy_model",
      "character_ip_goods",
      "audio_media",
      "digital_appliance",
      "stationery_publication",
      "fashion_wearable",
      "fashion_jewelry",
      "art_collectible",
      "daily_misc",
    ]) {
      assert.ok(sql.includes(`'${code}'`), code);
    }
  });

  test("pos_held_cart_items 补齐 4 个快照列并迁移历史数据", () => {
    for (const column of [
      "category_code",
      "category_name_snapshot",
      "subcategory_code",
      "subcategory_name_snapshot",
    ]) {
      assert.ok(sql.includes(`ADD COLUMN IF NOT EXISTS ${column} text`), column);
    }
    assert.match(sql, /SET subcategory_name_snapshot = subcategory_name/);
  });
});
