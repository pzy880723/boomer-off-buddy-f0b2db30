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
  it("close/reopen only primary or HQ; wechat cannot reply", () => {
    const c = { location_id: "L1", status: "open", primary_agent_id: "s1" };
    const other = { user_id: "s1b", is_hq_agent: false, location_ids: ["L1"] };
    assert.equal(supportCapabilities(other, c).can_close, false);
    assert.equal(supportCapabilities(hq, c).can_close, true);
    assert.equal(supportCapabilities(s1, { ...c, primary_agent_id: null }).can_close, false);
    assert.equal(supportCapabilities(s1, { ...c, channel: "wechat_kf" }).can_reply, false);
    assert.equal(supportCapabilities(s1, { ...c, channel: "wechat_kf" }).can_note, true);
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

import { decodeSupportCursor, encodeSupportCursor } from "./support-policy";
describe("support cursor", () => {
  it("round-trips updated_at + id and rejects garbage", () => {
    const row = { updated_at: "2026-10-05T12:00:00.123456+00:00", id: "c4cc4b1c-26d3-4178-93e8-be490cf7172b" };
    assert.deepEqual(decodeSupportCursor(encodeSupportCursor(row)), row);
    assert.equal(decodeSupportCursor(null), null);
    assert.equal(decodeSupportCursor("2026-10-05"), "invalid");
    assert.equal(decodeSupportCursor("x|c4cc4b1c-26d3-4178-93e8-be490cf7172b"), "invalid");
    assert.equal(decodeSupportCursor("2026-10-05T00:00:00Z|id,and(x)"), "invalid");
  });
});
