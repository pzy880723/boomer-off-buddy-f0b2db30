import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { planMembershipImport } from "../../../scripts/import-membership-snapshot";

describe("membership snapshot import planning", () => {
  test("matches external subject first and falls back to a unique phone", () => {
    const plan = planMembershipImport({
      legacyCustomers: [
        { id: "legacy-subject", phone: "13800000001" },
        { id: "legacy-phone", phone: "13800000002" },
      ],
      existingCustomers: [
        { id: "erp-1", external_subject: "legacy-subject", phone: "13800009999" },
        { id: "erp-2", external_subject: "another-subject", phone: "13800000002" },
      ],
      membershipOrders: [],
      consumptionRecords: [],
    });

    assert.deepEqual(plan.customerMap, {
      "legacy-subject": "erp-1",
      "legacy-phone": "erp-2",
    });
    assert.deepEqual(plan.quarantine, []);
  });

  test("quarantines identity conflicts instead of merging accounts", () => {
    const plan = planMembershipImport({
      legacyCustomers: [{ id: "legacy-1", phone: "13800000003" }],
      existingCustomers: [
        { id: "erp-subject", external_subject: "legacy-1", phone: "13800000004" },
        { id: "erp-phone", external_subject: "other", phone: "13800000003" },
      ],
      membershipOrders: [],
      consumptionRecords: [],
    });

    assert.deepEqual(plan.customerMap, {});
    assert.equal(plan.quarantine[0].legacy_customer_id, "legacy-1");
    assert.equal(plan.quarantine[0].reason, "identity_conflict");
  });

  test("preserves integer amounts and creates stable rerun idempotency keys", () => {
    const input = {
      legacyCustomers: [{ id: "legacy-1", phone: "13800000001" }],
      existingCustomers: [{ id: "erp-1", external_subject: "legacy-1", phone: "13800000001" }],
      membershipOrders: [{ id: "order-1", customer_id: "legacy-1", amount_fen: 9900 }],
      consumptionRecords: [{ id: "sale-1", customer_id: "legacy-1", paid_fen: 16850 }],
    };

    const first = planMembershipImport(input);
    const second = planMembershipImport(input);

    assert.equal(first.orders[0].amount_fen, 9900);
    assert.equal(first.consumptionRecords[0].paid_fen, 16850);
    assert.equal(first.orders[0].idempotency_key, "legacy:membership_order:order-1");
    assert.deepEqual(second, first);
  });
});
