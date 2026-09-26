import assert from "node:assert/strict";
import { test } from "node:test";
import { ProductContentRequest, mergeProductContentPreview } from "./product-content.ts";

const image = {
  id: "raw-detail",
  type: "image",
  storage_path: "sku-raw/2026-09-27/device/photo.jpg",
};
test("save requires a version and immutable operation ID; get/generate cannot publish", () => {
  assert.equal(ProductContentRequest.safeParse({ action: "save", blocks: [] }).success, false);
  assert.equal(
    ProductContentRequest.safeParse({
      action: "save",
      expected_version: 0,
      client_op_id: "save-0001",
      blocks: [image],
    }).success,
    true,
  );
  for (const action of ["get", "generate"]) {
    assert.equal(ProductContentRequest.safeParse({ action, publish: true }).success, false);
  }
});
test("blocks reject HTML, arbitrary URLs, path traversal, duplicates and unknown fields", () => {
  const invalid = [
    [{ ...image, storage_path: "https://example.com/x.jpg" }],
    [{ ...image, storage_path: "sku-raw/a.jpg?token=x" }],
    [{ ...image, storage_path: "sku-raw/%2e%2e/a.jpg" }],
    [{ ...image, storage_path: "sku-raw/../a.jpg" }],
    [{ ...image, storage_path: "sku-raw/a\\b.jpg" }],
    [{ ...image, storage_path: "parcel-item-images/a.jpg" }],
    [{ ...image, read_url: "https://signed" }],
    [image, image],
    [{ id: "p", type: "paragraph", text: "<script>alert(1)</script>" }],
    [{ id: "p", type: "paragraph", text: "https://signed?token=x" }],
    [{ id: "p", type: "facts" }],
  ];
  for (const blocks of invalid)
    assert.equal(
      ProductContentRequest.safeParse({
        action: "save",
        expected_version: 0,
        client_op_id: "save-0001",
        blocks,
      }).success,
      false,
    );
});
test("AI preview preserves every raw detail image and stable image ID without mutating draft", () => {
  const draft = [{ id: "old", type: "paragraph", text: "old" }, image];
  const generated = [{ id: "new", type: "paragraph", text: "new" }];
  const result = mergeProductContentPreview(draft as never, generated as never);
  assert.deepEqual(result, [generated[0], image]);
  assert.ok("text" in draft[0]);
  assert.equal(draft[0].text, "old");
});
