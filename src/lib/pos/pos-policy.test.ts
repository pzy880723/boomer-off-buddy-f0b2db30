import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addScannedProduct,
  calculatePosDiscount,
  validatePosTenders,
  type PosCartLine,
} from "./pos-policy";

const standard = {
  sku_id: "7baf7ec2-8061-4d3c-8f4d-d4698f5ac2bf",
  product_type: "standard" as const,
  name: "玩具 6.9",
  unit_price: 6.9,
  available_qty: 8,
};
const custom = {
  sku_id: "5df4ae35-f92f-475f-aa63-3f7d5d6d3dd7",
  product_type: "custom" as const,
  name: "中古相机",
  unit_price: 699,
  available_qty: 1,
};

describe("POS cart policy", () => {
  test("repeated standard scans increment quantity", () => {
    const once = addScannedProduct([], standard);
    assert.deepEqual(addScannedProduct(once, standard), [{ ...standard, quantity: 2 }]);
  });

  test("custom products can only be scanned once", () => {
    const once = addScannedProduct([], custom);
    assert.throws(() => addScannedProduct(once, custom), /already in cart/i);
  });

  test("does not let scans exceed available stock", () => {
    const full: PosCartLine[] = [{ ...standard, quantity: 8 }];
    assert.throws(() => addScannedProduct(full, standard), /available stock/i);
  });
});

describe("POS tender policy", () => {
  test("supports split tenders that exactly match the sale total", () => {
    assert.deepEqual(
      validatePosTenders(100, [
        { provider: "cash", amount: 40 },
        { provider: "bank_card", amount: 60, provider_transaction_id: "CARD-1" },
      ]),
      [
        { provider: "cash", amount: 40 },
        { provider: "bank_card", amount: 60, provider_transaction_id: "CARD-1" },
      ],
    );
  });

  test("requires a provider transaction for non-cash tenders", () => {
    assert.throws(
      () => validatePosTenders(100, [{ provider: "wechat", amount: 100 }]),
      /transaction/i,
    );
  });

  test("rejects an underpaid or overpaid sale", () => {
    assert.throws(() => validatePosTenders(100, [{ provider: "cash", amount: 99.99 }]), /match/i);
  });
});

describe("POS discount policy", () => {
  const lines = [
    { sku_id: standard.sku_id, quantity: 2, unit_price: 100, discount_eligible: true },
    { sku_id: custom.sku_id, quantity: 1, unit_price: 368, discount_eligible: false },
  ];

  test("applies a fixed reduction only to eligible merchandise", () => {
    assert.deepEqual(calculatePosDiscount(lines, { type: "amount", value: 20 }), {
      subtotal: 568,
      eligible_total: 200,
      excluded_total: 368,
      discount_total: 20,
      payable_total: 548,
    });
  });

  test("applies a percentage discount without changing excluded consignment", () => {
    assert.deepEqual(calculatePosDiscount(lines, { type: "percentage", value: 90 }), {
      subtotal: 568,
      eligible_total: 200,
      excluded_total: 368,
      discount_total: 20,
      payable_total: 548,
    });
  });

  test("rejects discounts larger than the eligible amount", () => {
    assert.throws(() => calculatePosDiscount(lines, { type: "amount", value: 201 }), /eligible/i);
  });
});
