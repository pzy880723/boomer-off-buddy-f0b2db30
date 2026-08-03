import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildPrintPayload } from "./handheld-print.server";

describe("handheld print payload", () => {
  test("keeps decimal prices instead of rounding a custom product to zero", () => {
    assert.equal(buildPrintPayload({ price_tier: 0.01 }).price_tag, "¥0.01");
    assert.equal(buildPrintPayload({ price_tier: 6.9 }).price_tag, "¥6.9");
    assert.equal(buildPrintPayload({ price_tier: 699 }).price_tag, "¥699");
  });
});
