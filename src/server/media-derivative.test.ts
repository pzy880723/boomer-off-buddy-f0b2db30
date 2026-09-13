import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DERIVATIVE_WIDTHS,
  buildTencentDerivativeUrl,
  parseStorageRef,
} from "../lib/media-derivative";
import { signDerivativeUrls } from "./media-derivative.server";

const PRIMARY = "https://sxddfcoiaboqcmeviykl.supabase.co";
const TENCENT = "https://migration-data.boomeroff.top";
const origins = { primary: PRIMARY, tencent: TENCENT };

describe("parseStorageRef", () => {
  test("bucket/path 与本项目绝对 URL（public / sign / render）都能解回安全 ref", () => {
    assert.deepEqual(parseStorageRef("sku-listing/a/b.jpg", origins), {
      origin: "primary",
      bucket: "sku-listing",
      path: "a/b.jpg",
    });
    assert.deepEqual(
      parseStorageRef(`${PRIMARY}/storage/v1/object/public/parcel-item-images/2026/a%20b.jpg`, origins),
      { origin: "primary", bucket: "parcel-item-images", path: "2026/a b.jpg" },
    );
    assert.deepEqual(
      parseStorageRef(`${PRIMARY}/storage/v1/object/sign/sku-raw/x.jpg?token=zzz`, origins),
      { origin: "primary", bucket: "sku-raw", path: "x.jpg" },
    );
    assert.deepEqual(
      parseStorageRef(`${PRIMARY}/storage/v1/render/image/public/shop-images/s.png?width=99`, origins),
      { origin: "primary", bucket: "shop-images", path: "s.png" },
    );
    assert.deepEqual(
      parseStorageRef(`${TENCENT}/storage/v1/object/public/parcel-item-images/n.jpg`, origins),
      { origin: "tencent", bucket: "parcel-item-images", path: "n.jpg" },
    );
  });

  test("外域 / data: / 未知桶 / 目录穿越 / 非存储路径一律 null", () => {
    assert.equal(parseStorageRef("https://thirdparty.example.com/a.jpg", origins), null);
    assert.equal(parseStorageRef("https://wx.qlogo.cn/avatar/0", origins), null);
    assert.equal(parseStorageRef("data:image/png;base64,AAA", origins), null);
    assert.equal(parseStorageRef(`${PRIMARY}/storage/v1/object/public/secret/a.jpg`, origins), null);
    assert.equal(parseStorageRef("sku-raw/../secret.jpg", origins), null);
    assert.equal(parseStorageRef(`${PRIMARY}/rest/v1/commerce_orders`, origins), null);
    assert.equal(parseStorageRef("", origins), null);
    assert.equal(parseStorageRef(null, origins), null);
  });

  test("未配置腾讯 origin 时腾讯地址不被认作已知存储", () => {
    assert.equal(
      parseStorageRef(`${TENCENT}/storage/v1/object/public/parcel-item-images/n.jpg`, {
        primary: PRIMARY,
      }),
      null,
    );
  });
});

describe("buildTencentDerivativeUrl", () => {
  test("公共桶产出精确的 render/image/public 契约", () => {
    const ref = parseStorageRef(
      `${TENCENT}/storage/v1/object/public/parcel-item-images/2026/a b.jpg`,
      origins,
    )!;
    assert.equal(
      buildTencentDerivativeUrl(ref, 480, TENCENT),
      `${TENCENT}/storage/v1/render/image/public/parcel-item-images/2026/a%20b.jpg?width=480&quality=75&resize=contain`,
    );
  });

  test("私有桶或非腾讯 ref 返回 null", () => {
    const priv: Parameters<typeof buildTencentDerivativeUrl>[0] = {
      origin: "tencent",
      bucket: "sku-raw",
      path: "a.jpg",
    };
    assert.equal(buildTencentDerivativeUrl(priv, 480, TENCENT), null);
    const primaryRef = parseStorageRef("sku-raw/a.jpg", origins)!;
    assert.equal(buildTencentDerivativeUrl(primaryRef, 480, TENCENT), null);
  });
});

describe("signDerivativeUrls", () => {
  const signOk = async (ref: { bucket: string; path: string }, width: number) =>
    `${PRIMARY}/storage/v1/render/image/sign/${ref.bucket}/${ref.path}?width=${width}&token=T`;

  test("真实缩放宽度透传，相同 ref 只签一次，顺序对齐", async () => {
    const calls: number[] = [];
    const out = await signDerivativeUrls(
      ["sku-listing/a.jpg", "sku-listing/a.jpg", "sku-raw/b.jpg"],
      DERIVATIVE_WIDTHS.preview,
      {
        ...origins,
        signPrimary: async (ref, width) => {
          calls.push(width);
          return signOk(ref, width);
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(new Set(calls), new Set([960]));
    assert.equal(out[0], out[1]);
    assert.match(out[0]!, /render\/image\/sign\/sku-listing\/a\.jpg\?width=960/);
    assert.match(out[2]!, /sku-raw\/b\.jpg\?width=960/);
  });

  test("签名失败或抛错一律 null，绝不回退原图", async () => {
    const out = await signDerivativeUrls(
      ["sku-listing/a.jpg", "sku-raw/b.jpg"],
      480,
      {
        ...origins,
        signPrimary: async (ref) => {
          if (ref.bucket === "sku-raw") throw new Error("boom");
          return null;
        },
      },
    );
    assert.deepEqual(out, [null, null]);
  });

  test("历史绝对 URL 快照重新签成衍生图；外域快照为 null", async () => {
    const out = await signDerivativeUrls(
      [
        `${PRIMARY}/storage/v1/object/public/parcel-item-images/old.jpg`,
        `${TENCENT}/storage/v1/object/public/parcel-item-images/new.jpg`,
        "https://img.example.com/legacy.jpg",
        "data:image/png;base64,AAA",
      ],
      480,
      { ...origins, signPrimary: signOk },
    );
    assert.match(out[0]!, /render\/image\/sign\/parcel-item-images\/old\.jpg\?width=480/);
    assert.equal(
      out[1],
      `${TENCENT}/storage/v1/render/image/public/parcel-item-images/new.jpg?width=480&quality=75&resize=contain`,
    );
    assert.equal(out[2], null);
    assert.equal(out[3], null);
  });
});
