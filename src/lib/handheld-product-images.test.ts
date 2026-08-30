import assert from "node:assert/strict";
import test from "node:test";
import {
  collectUniqueProductImagePaths,
  mergeSignedProductImages,
} from "./handheld-product-images.ts";

test("only signs unique image paths from the current page", () => {
  const page = [
    { id: "sku-1", image_paths: ["sku-listing/shared.jpg", "sku-listing/side.jpg"] },
    { id: "sku-2", image_paths: ["sku-listing/shared.jpg"] },
  ];

  assert.deepEqual(collectUniqueProductImagePaths(page), [
    "sku-listing/shared.jpg",
    "sku-listing/side.jpg",
  ]);
});

test("maps signed URLs back to every SKU while preserving image order", () => {
  const page = [
    { id: "sku-1", image_paths: ["sku-listing/shared.jpg", "sku-listing/side.jpg"] },
    { id: "sku-2", image_paths: ["sku-listing/shared.jpg"] },
  ];
  const signed = new Map([
    ["sku-listing/shared.jpg", "https://cdn.example/shared.jpg?token=1"],
    ["sku-listing/side.jpg", "https://cdn.example/side.jpg?token=1"],
  ]);

  const result = mergeSignedProductImages(page, signed);

  assert.deepEqual(result[0].images, [
    { storage_path: "sku-listing/shared.jpg", read_url: "https://cdn.example/shared.jpg?token=1" },
    { storage_path: "sku-listing/side.jpg", read_url: "https://cdn.example/side.jpg?token=1" },
  ]);
  assert.equal(result[0].image_url, "https://cdn.example/shared.jpg?token=1");
  assert.equal(result[1].image_url, "https://cdn.example/shared.jpg?token=1");
});
