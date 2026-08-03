import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildPublicSkuMediaUrl,
  parseSkuMediaPath,
  resolvePublicSkuImageUrls,
} from "./sku-media";

const ORIGIN = "https://boomer-off-buddy.lovable.app";

describe("sku media public urls", () => {
  test("私有桶路径转成公开代理地址，而不是原样丢给有赞", () => {
    assert.equal(buildPublicSkuMediaUrl("sku-listing/2026/a b.jpg", ORIGIN), 
      `${ORIGIN}/api/public/media/sku/sku-listing/2026/a%20b.jpg`,
    );
    assert.deepEqual(parseSkuMediaPath("sku-raw/x.jpg"), { bucket: "sku-raw", path: "x.jpg" });
  });

  test("未知桶、目录穿越、签名 URL 一律拒绝", () => {
    assert.equal(parseSkuMediaPath("secret/x.jpg"), null);
    assert.equal(parseSkuMediaPath("sku-raw/../x.jpg"), null);
    assert.equal(
      buildPublicSkuMediaUrl(
        "https://x.supabase.co/storage/v1/object/sign/a.jpg?token=abc",
        ORIGIN,
      ),
      null,
    );
  });

  test("稳定外链保持原样，批量去重并限量", () => {
    const urls = resolvePublicSkuImageUrls(
      [
        "https://cdn.example.com/a.jpg",
        "sku-listing/a.jpg",
        "sku-listing/a.jpg",
        null,
        "sku-listing/b.jpg",
      ],
      ORIGIN,
      2,
    );
    assert.deepEqual(urls, [
      "https://cdn.example.com/a.jpg",
      `${ORIGIN}/api/public/media/sku/sku-listing/a.jpg`,
    ]);
  });
});
