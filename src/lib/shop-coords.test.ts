import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeShopCoords } from "./shop-coords";

const NOW = "2026-10-05T03:00:00.000Z";

describe("normalizeShopCoords", () => {
  test("两者都缺省时不触碰坐标（地址修改不清空已有坐标）", () => {
    assert.equal(normalizeShopCoords({}), null);
    assert.equal(normalizeShopCoords({ latitude: undefined }), null);
  });

  test("成对填写合法 GCJ-02 坐标", () => {
    const r = normalizeShopCoords({ latitude: 31.223456, longitude: 121.46917 });
    assert.deepEqual(r, {
      latitude: 31.223456,
      longitude: 121.46917,
      coord_system: "gcj02",
    });
  });

  test("成对清空返回 null 对，不转 0", () => {
    const r = normalizeShopCoords({ latitude: null, longitude: null });
    assert.deepEqual(r, {
      latitude: null,
      longitude: null,
      coord_system: null,
    });
  });

  test("只填一个必须报错（成对约束）", () => {
    assert.throws(() => normalizeShopCoords({ latitude: 31.2 }), /成对/);
    assert.throws(() => normalizeShopCoords({ longitude: 121.4 }), /成对/);
    assert.throws(() => normalizeShopCoords({ latitude: null, longitude: 121.4 }), /成对/);
  });

  test("非法类型 / NaN / Infinity 报错", () => {
    assert.throws(() => normalizeShopCoords({ latitude: "31.2", longitude: 121.4 }), /数字/);
    assert.throws(() => normalizeShopCoords({ latitude: NaN, longitude: 121.4 }), /数字/);
    assert.throws(() => normalizeShopCoords({ latitude: 31.2, longitude: Infinity }), /数字/);
  });

  test("越界报错（WGS-84 误填或境外坐标）", () => {
    assert.throws(() => normalizeShopCoords({ latitude: 91, longitude: 121 }), /范围/);
    assert.throws(() => normalizeShopCoords({ latitude: 31.2, longitude: 139.7 }), /范围/);
    assert.throws(() => normalizeShopCoords({ latitude: 1.5, longitude: 103.8 }), /范围/);
    assert.throws(() => normalizeShopCoords({ latitude: 0, longitude: 0 }), /范围/);
  });

  test("超过 6 位小数报错", () => {
    assert.throws(
      () => normalizeShopCoords({ latitude: 31.2234567, longitude: 121.46917 }),
      /6 位小数/,
    );
  });

  test("显式非 gcj02 坐标系必须拒绝（不转换、不改名）", () => {
    assert.throws(
      () => normalizeShopCoords({ latitude: 31.22, longitude: 121.46, coord_system: "wgs84" }),
      /GCJ-02/,
    );
  });
});
