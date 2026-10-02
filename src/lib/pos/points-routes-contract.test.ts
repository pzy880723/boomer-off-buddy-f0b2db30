import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const route = (name: string) => readFileSync(new URL(`../../routes/api/public/pos/${name}.ts`,import.meta.url),"utf8");
test("zero-point sales retain v2 compatibility and positive requests fail closed", () => {
  const source = route("sales");
  assert.match(source,/body.points_to_redeem > 0 \? "pos_complete_sale_v3" : "pos_complete_sale_v2"/);
  assert.match(source,/body.points_to_redeem > 0 \? \{ p_points_to_redeem: body.points_to_redeem \} : \{\}/);
  assert.match(source,/points_rule_not_configured/);
});
test("native payment bodies do not strip points and reject before contacting providers", () => {
  for (const name of ["payments.micropay","payments.qr-order"]) {
    const source = route(name);
    assert.match(source,/points_to_redeem: z.number\(\).int\(\).min\(0\).max\(2147483647\).default\(0\)/);
    assert.ok(source.indexOf('"points_async_not_supported"') < source.indexOf("await findAttemptByClientOpId"));
    assert.match(source,/points_to_redeem: body.points_to_redeem/);
  }
  const server = readFileSync(new URL("../../server/pos-payment.server.ts",import.meta.url),"utf8");
  assert.match(server,/attempt.sale_payload.points_to_redeem/);
});
test("preview totals include points exactly once and missing migration disables the rules", () => {
  const source = route("discounts.preview");
  assert.match(source,/points_redemption: points/);
  assert.match(source,/combinedDiscount > 20/);
  assert.match(source,/moneyFen\(totals.payable_total\) - moneyFen\(points.discount_amount\)/);
  const loader = readFileSync(new URL("./points-policy.server.ts",import.meta.url),"utf8");
  assert.match(loader,/error\?\.code === "PGRST202"/);
});
