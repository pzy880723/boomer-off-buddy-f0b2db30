import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeShopCoords, shopCoordFieldsSchema, buildShopMetaPatch } from "./shop-coords";
import { z } from "zod";

const schema = z.object({ id: z.string(), address: z.string().nullish() }).merge(shopCoordFieldsSchema);

describe("保存服务坐标链路", () => {
  test("显式 wgs84 必须拒绝，不得改名为 gcj02", () => {
    assert.throws(() => normalizeShopCoords({ latitude: 31.22, longitude: 121.46, coord_system: "wgs84" }), /GCJ-02/);
  });
  test("保存 schema 不 strip coord_system，wgs84 经保存服务被拒", () => {
    const parsed = schema.parse({ id: "s", latitude: 31.22, longitude: 121.46, coord_system: "wgs84" });
    assert.equal((parsed as { coord_system?: string }).coord_system, "wgs84");
    assert.throws(() => buildShopMetaPatch(parsed), /GCJ-02/);
  });
  test("未提供坐标系时按表单标明的 gcj02 接受", () => {
    const p = buildShopMetaPatch(schema.parse({ id: "s", latitude: 31.22, longitude: 121.46 }));
    assert.equal(p.coord_system, "gcj02");
  });
  test("服务端补丁不自行写 coord_updated_at（由数据库触发器按是否真实变化决定）", () => {
    const p = buildShopMetaPatch(schema.parse({ id: "s", address: "x", latitude: 31.22, longitude: 121.46 }));
    assert.equal("coord_updated_at" in p, false);
    const c = buildShopMetaPatch(schema.parse({ id: "s", latitude: null, longitude: null }));
    assert.equal("coord_updated_at" in c, false);
    assert.equal(c.coord_system, null);
  });
  test("仅改地址时不触碰坐标字段", () => {
    const p = buildShopMetaPatch(schema.parse({ id: "s", address: "新地址" }));
    assert.deepEqual(p, { address: "新地址" });
  });
});
