import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildContextKey,
  deriveOrderLocation,
  supportCapabilities,
  supportError,
} from "./support-policy";

const hq = { user_id: "hq", is_hq_agent: true, location_ids: [] };
const s1 = { user_id: "s1", is_hq_agent: false, location_ids: ["L1"] };
const s2 = { user_id: "s2", is_hq_agent: false, location_ids: ["L2"] };

describe("supportCapabilities", () => {
  it("only primary agent can reply; collaborators note", () => {
    const c = { location_id: "L1", status: "open", primary_agent_id: "s1" };
    assert.equal(supportCapabilities(s1, c).can_reply, true);
    assert.equal(supportCapabilities(hq, c).can_reply, false);
    assert.equal(supportCapabilities(hq, c).can_note, true);
    assert.equal(supportCapabilities(hq, c).can_takeover, true);
    assert.equal(supportCapabilities(s2, c).can_note, false);
    assert.equal(supportCapabilities(s1, c).can_takeover, false);
  });
  it("closed blocks reply/claim, allows reopen", () => {
    const c = { location_id: "L1", status: "closed", primary_agent_id: "s1" };
    const caps = supportCapabilities(s1, c);
    assert.equal(caps.can_reply, false);
    assert.equal(caps.can_claim, false);
    assert.equal(caps.can_reopen, true);
  });
  it("HQ-only conversation (no location) invisible to store staff", () => {
    const c = { location_id: null, status: "open", primary_agent_id: null };
    assert.equal(supportCapabilities(s1, c).can_note, false);
    assert.equal(supportCapabilities(hq, c).can_claim, true);
  });
});

describe("context derivation", () => {
  it("single-store order belongs to that store; cross-store goes to HQ", () => {
    assert.equal(deriveOrderLocation(["L1", "L1"]), "L1");
    assert.equal(deriveOrderLocation(["L1", "L2"]), null);
    assert.equal(deriveOrderLocation(["L1", null]), null);
    assert.equal(deriveOrderLocation([]), null);
  });
  it("context keys are isolated per order/product/store", () => {
    assert.equal(buildContextKey({ orderId: "o" }), "order:o");
    assert.equal(buildContextKey({ productId: "p" }), "product:p");
    assert.equal(buildContextKey({ locationId: "L1" }), "general:L1");
    assert.equal(buildContextKey({}), "general");
  });
  it("errors are explained in Chinese with HTTP status", () => {
    assert.equal(supportError("version_conflict").status, 409);
    assert.match(supportError("assignment_version_required").message, /刷新/);
    assert.equal(supportError("nope").status, 500);
  });
});
