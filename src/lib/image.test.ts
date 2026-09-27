import assert from "node:assert/strict";
import test from "node:test";
import { toThumbUrl } from "./image.ts";

test("private object signatures remain unchanged at every list/gallery size", () => {
  const url = "https://storage.test/storage/v1/object/sign/sku-listing/reviewed.png?token=opaque%2Bsignature";
  for (const width of [96, 128, 480, 720]) assert.equal(toThumbUrl(url, width), url);
});

test("server-signed transformations are never resized or re-signed in the client", () => {
  const url = "https://storage.test/storage/v1/render/image/sign/sku-listing/reviewed.png?token=transform-signature";
  assert.equal(toThumbUrl(url, 128), url);
});

test("public images retain the existing thumbnail behavior", () => {
  assert.equal(
    toThumbUrl("https://storage.test/storage/v1/object/public/catalog/a.png", 128),
    "https://storage.test/storage/v1/render/image/public/catalog/a.png?width=128&quality=70&resize=contain",
  );
});

test("empty, external and data image references are preserved", () => {
  assert.equal(toThumbUrl(undefined), null);
  assert.equal(toThumbUrl(null), null);
  for (const url of ["", "https://cdn.test/image.png", "data:image/png;base64,AAA"])
    assert.equal(toThumbUrl(url), url);
});
