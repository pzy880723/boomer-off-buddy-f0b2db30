import { describe, expect, it } from "vitest";
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
  it("解析直辖市", () => {
    expect(parseCityFromAddress("上海市静安区 南京西路 1168 号")).toBe("上海市");
  });
  it("解析省+市", () => {
    expect(parseCityFromAddress("浙江省温州市鹿城区朔门古港")).toBe("温州市");
  });
  it("无法确定时返回 null，不编造", () => {
    expect(parseCityFromAddress("朔门古港 3 号铺")).toBeNull();
    expect(parseCityFromAddress(null)).toBeNull();
    expect(parseCityFromAddress("   ")).toBeNull();
  });
});

describe("过滤规则", () => {
  it("只保留 active 门店 + active 的 kind=shop 库位", () => {
    expect(isPublicShopRow(row())).toBe(true);
    expect(isPublicShopRow(row({ status: "disabled" }))).toBe(false);
    expect(
      isPublicShopRow(row({ location: { id: "l", name: "x", kind: "shop", is_active: false } })),
    ).toBe(false);
    expect(
      isPublicShopRow(
        row({ location: { id: "l", name: "总部仓库", kind: "warehouse", is_active: true } }),
      ),
    ).toBe(false);
    expect(isPublicShopRow(row({ location: null }))).toBe(false);
  });
});

describe("字段白名单", () => {
  it("id 为 location_id，且不含 manager/phone/token 等字段", () => {
    const out = toPublicShop(row(), null) as Record<string, unknown>;
    expect(out.id).toBe("loc-1");
    expect(out.shop_id).toBe("shop-1");
    expect(Object.keys(out).sort()).toEqual(
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
    expect(out.business_hours).toBeNull();
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });
});

describe("buildPublicShops", () => {
  it("只对有图门店签名，且签名结果按门店对齐", async () => {
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
    expect(asked).toEqual(["shops/b.jpg"]);
    expect(out.map((s) => s.id)).toEqual(["l1", "l2"]);
    expect(out.find((s) => s.id === "l1")?.image_url).toBeNull();
    expect(out.find((s) => s.id === "l2")?.image_url).toBe("signed:shops/b.jpg");
  });

  it("签名失败或抛错时降级为 null，仍返回门店", async () => {
    const failing = await buildPublicShops([row()], async () => {
      throw new Error("storage down");
    });
    expect(failing).toHaveLength(1);
    expect(failing[0].image_url).toBeNull();

    const nulled = await buildPublicShops([row()], async (paths) => paths.map(() => null));
    expect(nulled[0].image_url).toBeNull();
  });
});
