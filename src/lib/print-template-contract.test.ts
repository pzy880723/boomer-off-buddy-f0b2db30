import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { LabelTemplateCreateReq, LabelTemplateItem } from "./handheld/schemas";

test("legacy templates default to label type", () => {
  const parsed = LabelTemplateItem.parse({
    id: "f5c127f0-46b8-4ea0-90b9-9ff9ae976490",
    name: "默认商品标签",
    width_mm: 53,
    height_mm: 35,
    is_default: true,
    elements: [],
    version: 1,
    updated_at: "2026-07-28T00:00:00.000Z",
  });

  assert.equal(parsed.print_type, "label");
});

test("receipt templates are always normalized to 58mm", () => {
  const parsed = LabelTemplateCreateReq.parse({
    name: "门店销售小票",
    print_type: "receipt",
    width_mm: 80,
    height_mm: 120,
    elements: [],
  });

  assert.equal(parsed.print_type, "receipt");
  assert.equal(parsed.width_mm, 58);
});

test("POS print stylesheet uses the supported 58mm receipt width", () => {
  const source = readFileSync("src/routes/pos.tsx", "utf8");

  assert.match(source, /@page \{ size: 58mm auto;/);
  assert.doesNotMatch(source, /@page \{ size: 80mm auto;/);
});

test("openapi documents per-print-type defaults and receipt templates", async () => {
  const { buildHandheldOpenApi } = await import("./handheld/openapi");
  const doc = buildHandheldOpenApi() as any;
  const list = doc.paths["/api/public/handheld/label-templates"];
  assert.match(list.get.description, /default_template_ids/);
  assert.match(list.post.description, /print_type/);
  assert.match(
    doc.paths["/api/public/handheld/label-templates/{id}/set-default"].post.description,
    /同一 print_type/,
  );
});

test("label-templates GET supports print_type filtering without touching other types", () => {
  const source = readFileSync("src/routes/api/public/handheld/label-templates.ts", "utf8");
  assert.match(source, /searchParams\.get\("print_type"\)/);
  // 默认切换只在同一 print_type 范围内生效
  assert.match(source, /\.eq\("is_default", true\)\s*\n\s*\.eq\("print_type", print_type\)/);
});
