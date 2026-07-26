import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const openapiSource = readFileSync(
  new URL("./handheld/openapi.ts", import.meta.url),
  "utf8",
);

const snapshot = JSON.parse(
  readFileSync(new URL("../../openapi.snapshot.json", import.meta.url), "utf8"),
) as { paths?: Record<string, unknown> };

const storefrontPaths = [
  "/api/public/storefront/products",
  "/api/public/storefront/products/{id}",
  "/api/public/storefront/taxonomy",
  "/api/public/storefront/orders",
  "/api/public/storefront/orders/{id}",
];

describe("storefront OpenAPI contract", () => {
  test("documents every public storefront route in the generated source", () => {
    for (const path of storefrontPaths) {
      assert.match(openapiSource, new RegExp(path.replace(/[{}]/g, "\\$&")));
    }
  });

  test("keeps the committed OpenAPI snapshot aligned with storefront routes", () => {
    for (const path of storefrontPaths) {
      assert.ok(snapshot.paths?.[path], `missing OpenAPI path: ${path}`);
    }
  });
});
