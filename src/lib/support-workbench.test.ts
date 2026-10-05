import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterSupportConversations,
  supportErrorMessage,
  supportReplyPermission,
  supportRetryKey,
} from "./support-workbench";

const mine = {
  status: "open",
  primary_agent_id: "staff-a",
  assignment_version: 2,
  channel: "native",
  can_reply: true,
  can_note: true,
};

test("retry identity excludes assignment version and isolates conversation, body and mode", () => {
  assert.equal(supportRetryKey("c1", "hello ", false), supportRetryKey("c1", "hello", false));
  assert.notEqual(supportRetryKey("c1", "hello", false), supportRetryKey("c2", "hello", false));
  assert.notEqual(supportRetryKey("c1", "hello", false), supportRetryKey("c1", "hello", true));
});

test("reply is blocked before assignment and during stale detail loading", () => {
  assert.equal(supportReplyPermission(null, "staff-a", false).allowed, false);
  assert.equal(
    supportReplyPermission({ ...mine, primary_agent_id: null }, "staff-a", false).allowed,
    false,
  );
  assert.equal(
    supportReplyPermission({ ...mine, assignment_version: undefined }, "staff-a", false).allowed,
    false,
  );
});

test("old owner cannot reply after headquarters takes over, but may add an authorized note", () => {
  assert.equal(
    supportReplyPermission({ ...mine, primary_agent_id: "hq" }, "staff-a", false).allowed,
    false,
  );
  assert.equal(
    supportReplyPermission({ ...mine, primary_agent_id: "hq" }, "staff-a", true).allowed,
    true,
  );
});

test("closed conversations and unconnected channels never pretend to send", () => {
  assert.equal(
    supportReplyPermission({ ...mine, status: "closed" }, "staff-a", true).allowed,
    false,
  );
  assert.equal(
    supportReplyPermission({ ...mine, channel: "wechat_kf" }, "staff-a", false).allowed,
    false,
  );
  assert.equal(
    supportReplyPermission({ ...mine, channel: "wechat_kf" }, "staff-a", true).allowed,
    true,
  );
});

test("server denial overrides local owner identity", () => {
  assert.equal(
    supportReplyPermission({ ...mine, can_reply: false }, "staff-a", false).allowed,
    false,
  );
  assert.equal(
    supportReplyPermission({ ...mine, can_note: false }, "staff-a", true).allowed,
    false,
  );
});

test("waiting and escalated filters exclude resolved cases", () => {
  const rows = [
    { id: "a", status: "open", primary_agent_id: null, escalated_at: null },
    { id: "b", status: "open", primary_agent_id: "staff-a", escalated_at: null },
    { id: "c", status: "pending", primary_agent_id: null, escalated_at: "2026-10-05" },
    { id: "d", status: "closed", primary_agent_id: null, escalated_at: "2026-10-05" },
  ];
  assert.deepEqual(
    filterSupportConversations(rows, "waiting").map((r) => r.id),
    ["a", "c"],
  );
  assert.deepEqual(
    filterSupportConversations(rows, "mine", "staff-a").map((r) => r.id),
    ["b"],
  );
  assert.deepEqual(
    filterSupportConversations(rows, "escalated").map((r) => r.id),
    ["c"],
  );
});

test("assignment conflicts have an actionable message rather than a raw server code", () => {
  assert.match(supportErrorMessage("assignment_conflict"), /刷新|接待/);
  assert.match(supportErrorMessage("not_primary_agent"), /接待|接管/);
  assert.match(supportErrorMessage("channel_not_connected"), /微信|渠道/);
  assert.equal(supportErrorMessage("门店权限不足"), "门店权限不足");
});
