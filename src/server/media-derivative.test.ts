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

  test("解码后仍拒绝目录穿越 / 反斜杠 / 编码斜杠 / 未知 scheme（fail-closed）", () => {
    // 非 HTTP bucket/path 分支：%2e%2e 解码后是 ..
    assert.equal(parseStorageRef("sku-listing/%2e%2e/secret", origins), null);
    assert.equal(parseStorageRef("sku-listing/a/%2E%2E/b.jpg", origins), null);
    // 编码斜杠：段解码后出现隐藏的 "/"
    assert.equal(parseStorageRef("sku-listing/a%2fb.jpg", origins), null);
    assert.equal(parseStorageRef(`${PRIMARY}/storage/v1/object/public/sku-listing/a%2fb.jpg`, origins), null);
    // 反斜杠
    assert.equal(parseStorageRef("sku-listing/a\\b.jpg", origins), null);
    assert.equal(parseStorageRef("sku-listing/%5c/secret", origins), null);
    assert.equal(parseStorageRef(`${PRIMARY}/storage/v1/object/public/sku-listing/a%5Cb.jpg`, origins), null);
    // URL 分支解码后穿越
    assert.equal(parseStorageRef(`${PRIMARY}/storage/v1/object/public/sku-listing/%2e%2e/secret`, origins), null);
    // 未知 scheme / 伪协议
    assert.equal(parseStorageRef("ftp://example.com/sku-listing/a.jpg", origins), null);
    assert.equal(parseStorageRef("javascript:alert(1)", origins), null);
    assert.equal(parseStorageRef("//evil.com/sku-listing/a.jpg", origins), null);
    // 合法值不受影响
    assert.deepEqual(parseStorageRef("sku-listing/a/b.jpg", origins), {
      origin: "primary",
      bucket: "sku-listing",
      path: "a/b.jpg",
    });
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

  test("width 只接受固定档位 160/480/960，其余一律 null（fail-closed）", () => {
    const ref = parseStorageRef(
      `${TENCENT}/storage/v1/object/public/parcel-item-images/a.jpg`,
      origins,
    )!;
    for (const w of [160, 480, 960]) {
      assert.match(buildTencentDerivativeUrl(ref, w, TENCENT)!, new RegExp(`width=${w}&`));
    }
    for (const w of [0, -1, 1, 100, 479, 481, 9999, 480.5, Number.NaN]) {
      assert.equal(buildTencentDerivativeUrl(ref, w, TENCENT), null, `width=${w} 必须拒绝`);
    }
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
        primaryOrigin: PRIMARY, tencentOrigin: TENCENT,
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
        primaryOrigin: PRIMARY, tencentOrigin: TENCENT,
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
      { primaryOrigin: PRIMARY, tencentOrigin: TENCENT, signPrimary: signOk, tencentRenderVerified: true },
    );
    assert.match(out[0]!, /render\/image\/sign\/parcel-item-images\/old\.jpg\?width=480/);
    assert.equal(
      out[1],
      `${TENCENT}/storage/v1/render/image/public/parcel-item-images/new.jpg?width=480&quality=75&resize=contain`,
    );
    assert.equal(out[2], null);
    assert.equal(out[3], null);
  });

  test("width 非 160/480/960 档位时全部 null 且不发起签名（fail-closed）", async () => {
    let calls = 0;
    const out = await signDerivativeUrls(
      [
        "sku-listing/a.jpg",
        `${TENCENT}/storage/v1/object/public/parcel-item-images/new.jpg`,
      ],
      500,
      {
        primaryOrigin: PRIMARY, tencentOrigin: TENCENT, tencentRenderVerified: true,
        signPrimary: async () => {
          calls++;
          return "x";
        },
      },
    );
    assert.deepEqual(out, [null, null]);
    assert.equal(calls, 0);
  });

  test("腾讯 render 能力未显式验证时腾讯 ref 一律 null；验证后才产出", async () => {
    const tencentValue = `${TENCENT}/storage/v1/object/public/parcel-item-images/new.jpg`;
    // 默认（未验证）：null
    const unverified = await signDerivativeUrls([tencentValue], 480, {
      primaryOrigin: PRIMARY, tencentOrigin: TENCENT, signPrimary: signOk,
    });
    assert.deepEqual(unverified, [null]);
    // 显式 false：null
    const explicitFalse = await signDerivativeUrls([tencentValue], 480, {
      primaryOrigin: PRIMARY, tencentOrigin: TENCENT, signPrimary: signOk,
      tencentRenderVerified: false,
    });
    assert.deepEqual(explicitFalse, [null]);
    // 显式已验证：产出契约 URL
    const verified = await signDerivativeUrls([tencentValue], 480, {
      primaryOrigin: PRIMARY, tencentOrigin: TENCENT, signPrimary: signOk,
      tencentRenderVerified: true,
    });
    assert.equal(
      verified[0],
      `${TENCENT}/storage/v1/render/image/public/parcel-item-images/new.jpg?width=480&quality=75&resize=contain`,
    );
    // 腾讯 gate 不影响本项目 ref
    const primary = await signDerivativeUrls(["sku-listing/a.jpg"], 480, {
      primaryOrigin: PRIMARY, tencentOrigin: TENCENT, signPrimary: signOk,
    });
    assert.match(primary[0]!, /render\/image\/sign\/sku-listing\/a\.jpg\?width=480/);
  });
});
