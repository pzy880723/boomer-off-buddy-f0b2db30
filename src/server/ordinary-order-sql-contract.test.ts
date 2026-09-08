import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const sql = readFileSync("supabase/migrations/20260907171143_ordinary_wechat_payment.sql", "utf8");

describe("ordinary order SQL contract", () => {
  it("第三方/寄售商品禁止进入普通商户通道", () => {
    assert.match(sql, /sale_ownership='owned'/);
    assert.match(sql, /SKU ownership is not self-operated/);
    assert.match(sql, /bundle component ownership is not self-operated/);
    assert.match(sql, /location is not an approved self-operated location/);
  });

  it("支付快照固化模式/商户主体/门店归属且不可变", () => {
    assert.match(sql, /payment route is immutable/);
    assert.match(sql, /payment snapshot is immutable/);
    assert.match(sql, /refund snapshot is immutable/);
    assert.match(
      sql,
      /'mode','ordinary_wechat',\s*\n?\s*'merchant_id',p_merchant_id,'app_id',p_app_id/,
    );
    assert.match(sql, /'location_ids',v_locations/);
  });

  it("老订单不得被转换成普通商户通道", () => {
    assert.match(sql, /legacy order route cannot be converted/);
    assert.match(sql, /not an ordinary order route/);
  });
});
