import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildPublicShops,
  isPublicShopRow,
  parseCityFromAddress,
  toPublicShop,
  type ShopSourceRow,
} from "./storefront-shops.server";

const row = (over: Partial<ShopSourceRow> = {}): ShopSourceRow => ({
  id: "shop-1",
  shop_name: "中信泰富店",
  status: "active",
  address: "上海市静安区 南京西路 1168 号",
  image_url: "shops/a.jpg",
  location: { id: "loc-1", name: "中信泰富店", kind: "shop", is_active: true },
  ...over,
});

describe("parseCityFromAddress", () => {
  test("解析直辖市", () => {
    assert.equal(parseCityFromAddress("上海市静安区 南京西路 1168 号"), "上海市");
  });
  test("解析省+市", () => {
    assert.equal(parseCityFromAddress("浙江省温州市鹿城区朔门古港"), "温州市");
  });
  test("无法确定时返回 null，不编造", () => {
    assert.equal(parseCityFromAddress("朔门古港 3 号铺"), null);
    assert.equal(parseCityFromAddress(null), null);
    assert.equal(parseCityFromAddress("   "), null);
  });
});

describe("过滤规则", () => {
  test("只保留 active 门店 + active 的 kind=shop 库位", () => {
    assert.equal(isPublicShopRow(row()), true);
    assert.equal(isPublicShopRow(row({ status: "disabled" })), false);
    assert.equal(
      isPublicShopRow(row({ location: { id: "l", name: "x", kind: "shop", is_active: false } })),
      false,
    );
    assert.equal(
      isPublicShopRow(
        row({ location: { id: "l", name: "总部仓库", kind: "warehouse", is_active: true } }),
      ),
      false,
    );
    assert.equal(isPublicShopRow(row({ location: null })), false);
  });
});

describe("字段白名单", () => {
  test("id 为 location_id，且不含 manager/phone/token 等字段", () => {
    const out = toPublicShop(row(), null) as Record<string, unknown>;
    assert.equal(out.id, "loc-1");
    assert.equal(out.shop_id, "shop-1");
    assert.deepEqual(
      Object.keys(out).sort(),
      [
        "address",
        "business_hours",
        "city",
        "id",
        "image_url",
        "latitude",
        "longitude",
        "name",
        "shop_id",
      ].sort(),
    );
    assert.deepEqual(out.business_hours, null);
    assert.equal(out.latitude, null);
    assert.equal(out.longitude, null);
  });
});

describe("buildPublicShops", () => {
  test("只对有图门店签名，且签名结果按门店对齐", async () => {
    const asked: string[] = [];
    const out = await buildPublicShops(
      [
        row({ id: "s1", shop_name: "A店", image_url: null, location: { id: "l1", name: "A", kind: "shop", is_active: true } }),
        row({ id: "s2", shop_name: "B店", image_url: "shops/b.jpg", location: { id: "l2", name: "B", kind: "shop", is_active: true } }),
        row({ id: "s3", shop_name: "仓库", image_url: "shops/c.jpg", location: { id: "l3", name: "仓库", kind: "warehouse", is_active: true } }),
      ],
      async (paths) => {
        asked.push(...paths);
        return paths.map((p) => `signed:${p}`);
      },
    );
    assert.deepEqual(asked, ["shops/b.jpg"]);
    assert.deepEqual(
      out.map((s) => s.id),
      ["l1", "l2"],
    );
    assert.equal(out.find((s) => s.id === "l1")?.image_url, null);
    assert.equal(out.find((s) => s.id === "l2")?.image_url, "signed:shops/b.jpg");
  });

  test("签名失败或抛错时降级为 null，仍返回门店", async () => {
    const failing = await buildPublicShops([row()], async () => {
      throw new Error("storage down");
    });
    assert.equal(failing.length, 1);
    assert.equal(failing[0].image_url, null);

    const nulled = await buildPublicShops([row()], async (paths) => paths.map(() => null));
    assert.equal(nulled[0].image_url, null);
  });
});
