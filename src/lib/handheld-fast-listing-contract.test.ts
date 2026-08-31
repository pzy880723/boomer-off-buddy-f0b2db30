import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("handheld fast listing contract", () => {
  test("product list and detail expose persisted background image processing state", () => {
    const schemas = read("./handheld/schemas.ts");
    const productsRoute = read("../routes/api/public/handheld/products.ts");
    const detailRoute = read("../routes/api/public/handheld/items.$id.ts");

    assert.match(schemas, /image_processing_status/);
    assert.match(productsRoute, /image_processing_status/);
    assert.match(detailRoute, /image_processing_status/);
  });

  test("recognition asks for the most specific visible IP role", () => {
    const recognition = read("../server/product-recognition.server.ts");

    assert.match(recognition, /Hello Kitty/);
    assert.match(recognition, /具体角色/);
    assert.match(recognition, /母品牌/);
  });

  test("taxonomy migration preserves Sanrio while creating a dedicated Hello Kitty IP", () => {
    const migration = read(
      "../../supabase/migrations/20260831213000_hello_kitty_specific_ip.sql",
    );

    assert.match(migration, /Hello Kitty/);
    assert.match(migration, /三丽鸥/);
    assert.match(migration, /凯蒂猫/);
  });
});
