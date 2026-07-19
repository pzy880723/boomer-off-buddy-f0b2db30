import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAigcRedirectUrl,
  hasAigcAccess,
  isActiveBan,
  isValidSsoTicket,
} from "../src/lib/aigc-sso-contract";

test("allows headquarters and store roles but rejects warehouse-only users", () => {
  assert.equal(hasAigcAccess(["super_admin"], []), true);
  assert.equal(hasAigcAccess(["store_staff"], []), true);
  assert.equal(hasAigcAccess(["warehouse_staff"], []), false);
});

test("allows an explicit aigc_access permission", () => {
  assert.equal(hasAigcAccess(["warehouse_staff"], ["aigc_access"]), true);
});

test("treats only future ban timestamps as active", () => {
  const now = Date.parse("2026-07-19T08:00:00.000Z");
  assert.equal(isActiveBan("2026-07-19T08:01:00.000Z", now), true);
  assert.equal(isActiveBan("2026-07-19T07:59:00.000Z", now), false);
  assert.equal(isActiveBan(null, now), false);
});

test("accepts only 32-byte base64url SSO tickets", () => {
  assert.equal(isValidSsoTicket("A".repeat(43)), true);
  assert.equal(isValidSsoTicket("A".repeat(42)), false);
  assert.equal(isValidSsoTicket("A".repeat(42) + "+"), false);
});

test("builds the ERP redirect from the configured AIGC base URL", () => {
  assert.equal(
    buildAigcRedirectUrl("https://aigc.boomeroff.com/", "A".repeat(43)),
    `https://aigc.boomeroff.com/auth/erp?ticket=${"A".repeat(43)}`,
  );
});
