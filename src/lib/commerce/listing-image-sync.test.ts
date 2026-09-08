import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyListingImageReplacement } from "./listing-image-sync";

const RAW = "sku-raw/2026-09-06/loc/45233351.jpg";
const LISTING = "sku-listing/2026-09-06/sku/1-d0e13684.png";

describe("applyListingImageReplacement", () => {
  it("替换仍引用原图的商城图片，位置保持不变", () => {
    const r = applyListingImageReplacement(["a.png", RAW, "b.png"], RAW, LISTING);
    assert.equal(r.changed, true);
    assert.deepEqual(r.next, ["a.png", LISTING, "b.png"]);
  });

  it("保留人工单独指定的商城封面与其它图片", () => {
    const manual = "sku-listing/manual/cover.png";
    const r = applyListingImageReplacement([manual, RAW], RAW, LISTING);
    assert.deepEqual(r.next, [manual, LISTING]);
  });

  it("原图不在列表中时不做任何改动", () => {
    const r = applyListingImageReplacement([LISTING], RAW, LISTING);
    assert.equal(r.changed, false);
    assert.deepEqual(r.next, [LISTING]);
  });

  it("成图路径缺失时不覆盖有效旧图", () => {
    const r = applyListingImageReplacement([RAW], RAW, "");
    assert.equal(r.changed, false);
    assert.deepEqual(r.next, [RAW]);
  });

  it("空列表不会凭空造图", () => {
    assert.deepEqual(applyListingImageReplacement([], RAW, LISTING), { changed: false, next: [] });
    assert.deepEqual(applyListingImageReplacement(null, RAW, LISTING), {
      changed: false,
      next: [],
    });
  });

  it("成图已存在时去重且不产生重复项", () => {
    const r = applyListingImageReplacement([LISTING, RAW], RAW, LISTING);
    assert.equal(r.changed, true);
    assert.deepEqual(r.next, [LISTING]);
  });

  it("忽略空白与非字符串脏数据", () => {
    const r = applyListingImageReplacement([" ", 42, RAW] as unknown[], RAW, LISTING);
    assert.deepEqual(r.next, [LISTING]);
  });
});
