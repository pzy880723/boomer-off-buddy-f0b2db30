import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBySku,
  buildChannelViews,
  consumerChannelAllowed,
  evaluateSalesIntentTask,
  planSkuChanges,
  resolveConsumerChannel,
  singleRequestFingerprint,
  type ChannelFacts,
} from "./model";

const base = (o: Partial<ChannelFacts> = {}): ChannelFacts => ({
  stockQty: 1,
  salesState: "active",
  listing: { status: "published", readiness_hold: false },
  shop: { bound: true, authorized: true },
  youzan: { external_item_id: "123", listing_status: "published", last_verified_at: "2026-10-27T00:00:00Z" },
  youzanPending: false,
  intents: [],
  ...o,
});
const view = (f: ChannelFacts, c: string) => buildChannelViews(f).find((v) => v.channel === c)!;

test("legacy item without intent keeps current behaviour (default source)", () => {
  const v = buildChannelViews(base());
  assert.deepEqual(v.map((x) => [x.channel, x.selected, x.selection_source]), [
    ["miniapp", true, "default"], ["app", true, "default"], ["youzan", true, "default"],
  ]);
  assert.equal(view(base({ youzan: { external_item_id: "1", listing_status: "unshelved", last_verified_at: null } }), "youzan").selected, false);
});

test("selection is separate from platform status", () => {
  const f = base({ listing: { status: "published", readiness_hold: true }, youzanPending: true,
    intents: [{ channel: "youzan", enabled: false, version: 2 }] });
  assert.equal(view(f, "miniapp").platform_status, "hidden");
  const y = view(f, "youzan");
  assert.equal(y.selected, false);
  assert.equal(y.platform_status, "syncing");
  assert.equal(y.version, 2);
  assert.equal(y.is_store_channel, true);
});

test("unavailable youzan shows Chinese reason, no fake switch", () => {
  assert.equal(view(base({ shop: { bound: false, authorized: false } }), "youzan").available, false);
  assert.match(view(base({ shop: { bound: true, authorized: false } }), "youzan").blocked_reason!, /授权已过期/);
  assert.match(view(base({ youzan: null }), "youzan").blocked_reason!, /尚未建立/);
});

test("sold item cannot be re-enabled but can be disabled", () => {
  const f = base({ salesState: "sold", intents: [{ channel: "miniapp", enabled: false, version: 1 }] });
  assert.equal(view(f, "miniapp").available, false);
  assert.equal(view(base({ salesState: "sold" }), "miniapp").available, true); // currently on -> may turn off
});

test("zero stock blocks youzan enable only", () => {
  const off = base({ stockQty: 0, intents: [{ channel: "youzan", enabled: false, version: 1 }] });
  assert.equal(view(off, "youzan").available, false);
  assert.equal(view(base({ stockQty: 0 }), "youzan").available, true);
});

test("batch plan: store-only removes consumer channels, never youzan; skips not-in-store", () => {
  const p = planSkuChanges(base({ intents: [{ channel: "app", enabled: true, version: 3 }] }), [], ["miniapp", "app"]);
  assert.deepEqual(p.changes, { miniapp: { enabled: false, expected_version: 0 }, app: { enabled: false, expected_version: 3 } });
  assert.equal(planSkuChanges(base({ stockQty: null }), ["miniapp"], []).skipReason, "not_in_store");
  assert.equal(planSkuChanges(base({ youzan: null }), ["youzan"], []).skipReason, "youzan_not_mapped");
});

test("consumer channel only from signed claims; unknown is conservative", () => {
  assert.equal(resolveConsumerChannel(null), "unknown");
  assert.equal(resolveConsumerChannel({ clientKind: null, wechatMiniAppId: "wx1" }), "miniapp");
  assert.equal(resolveConsumerChannel({ clientKind: "app" }), "app");
  assert.equal(resolveConsumerChannel({ clientKind: "web" as never }), "unknown");
  const off = [{ channel: "miniapp" }];
  assert.equal(consumerChannelAllowed(off, "app"), true);
  assert.equal(consumerChannelAllowed(off, "miniapp"), false);
  assert.equal(consumerChannelAllowed(off, "unknown"), false);
  assert.equal(consumerChannelAllowed([], "unknown"), true);
});

test("worker recheck: stale version / sold / no stock superseded; read failure blocks", () => {
  const task = { action: "shelf", request_payload: { source: "sales_channel_intent", intent_version: 2, location_id: "L" } };
  const ok = { intent: { enabled: true, version: 2 }, salesState: "active", stockQty: 1 };
  assert.equal(evaluateSalesIntentTask(task, ok).verdict, "proceed");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, intent: { enabled: true, version: 3 } }).verdict, "supersede");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, salesState: "sold" }).verdict, "supersede");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, stockQty: 0 }).verdict, "supersede");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, readFailed: true }).verdict, "block");
  const delist = { action: "delist", request_payload: { source: "sales_channel_intent", intent_version: 2 } };
  assert.equal(evaluateSalesIntentTask(delist, { ...ok, intent: { enabled: false, version: 2 }, salesState: "sold", stockQty: 0 }).verdict, "proceed");
});

test("batch aggregate per sku and fingerprint is order independent", () => {
  const r = aggregateBySku(["a", "b"], [
    { sku_id: "a", channel: "app", success: true, status: "applied" },
    { sku_id: "b", channel: "app", success: false, reason: "version_conflict" },
  ]);
  assert.deepEqual(r[0], { sku_id: "a", success: true, status: "applied" });
  assert.match(r[1].reason!, /刷新/);
  assert.equal(
    singleRequestFingerprint("s", [{ channel: "app", enabled: true, expected_version: 0 }, { channel: "miniapp", enabled: false, expected_version: 1 }]),
    singleRequestFingerprint("s", [{ channel: "miniapp", enabled: false, expected_version: 1 }, { channel: "app", enabled: true, expected_version: 0 }]),
  );
});
