import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

describe("commerce operations center", () => {
  test("provides one real-data operations page for storefront and POS", () => {
    const route = new URL("../../routes/shop-mgmt.commerce.tsx", import.meta.url);
    assert.equal(existsSync(route), true);
    const source = readFileSync(route, "utf8");
    for (const label of ["网店运营中心", "自营网店", "有赞兼容渠道", "门店收银", "最近订单"]) {
      assert.match(source, new RegExp(label));
    }
    assert.match(source, /getCommerceOperationsSummary/);
    assert.doesNotMatch(source, /mock|演示数据/i);
  });
});
