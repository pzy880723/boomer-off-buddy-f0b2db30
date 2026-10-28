import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBySku,
  assertShelfReadback,
  reasonLabel,
  channelBlocks,
  writeRecheckPlan,
  summarizeSingle,
  buildChannelViews,
  consumerChannelAllowed,
  evaluateSalesIntentTask,
  planSkuChanges,
  resolveConsumerChannel,
  catalogDisplayChannel,
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

test("batch plan: one blocked channel skips the whole SKU (never silently dropped)", () => {
  const p = planSkuChanges(base({ youzan: null }), [], ["app", "youzan"]);
  assert.deepEqual(p.changes, {});
  assert.equal(p.skipReason, "youzan_not_mapped");
  assert.equal(p.blockedChannel, "youzan");
});

test("reason labels never leak raw codes; readback must reach target", () => {
  assert.equal(reasonLabel("something_new"), "操作未完成，请刷新后重试");
  assert.throws(() => assertShelfReadback(null, true, 1), /未找到/);
  assert.throws(() => assertShelfReadback({ itemId: 2, isDisplay: true }, true, 1), /不一致/);
  assert.throws(() => assertShelfReadback({ itemId: 1, isDisplay: false }, true, 1), /未达到目标/);
  assert.doesNotThrow(() => assertShelfReadback({ itemId: 1, isDisplay: false }, false, 1));
  assert.deepEqual(summarizeSingle([{ sku_id: "s", channel: "app", success: true }, { sku_id: "s", channel: "youzan", success: false }]),
    { all_succeeded: false, succeeded: 1, failed: 1 });
  assert.equal(view(base({ youzanFailed: true }), "youzan").platform_status, "error");
});

test("consumer channel only from signed claims; unknown is conservative", () => {
  assert.equal(resolveConsumerChannel(null), "unknown");
  // 绑定历史不是会话来源：有 mini 绑定的 APP 会话不能被认成小程序
  assert.equal(resolveConsumerChannel({ clientKind: null, wechatMiniAppId: "wx1" } as never), "unknown");
  assert.equal(resolveConsumerChannel({ clientKind: "app", wechatMiniAppId: "wx1" } as never), "app");
  assert.equal(catalogDisplayChannel("miniapp"), "miniapp");
  assert.equal(catalogDisplayChannel("pos"), "unknown");
  assert.equal(resolveConsumerChannel({ clientKind: "app" }), "app");
  assert.equal(resolveConsumerChannel({ clientKind: "web" as never }), "unknown");
  const off = [{ channel: "miniapp" }];
  assert.equal(consumerChannelAllowed(off, "app"), true);
  assert.equal(consumerChannelAllowed(off, "miniapp"), false);
  assert.equal(consumerChannelAllowed(off, "unknown"), false);
  assert.equal(consumerChannelAllowed([], "unknown"), true);
});

test("worker recheck: stale version / sold / no stock superseded; read failure blocks", () => {
  const own = { sku_id: "S", shop_id: "SH", channel: "youzan_branch_offline", channel_listing_id: "CL" };
  const task = { ...own, action: "shelf", request_payload: { source: "sales_channel_intent", intent_version: 2, location_id: "L" } };
  const ok = { intent: { enabled: true, version: 2 }, salesState: "active", stockQty: 1,
    location: { shop_id: "SH", is_active: true, kind: "shop" }, shopActive: true,
    listing: { sku_id: "S", shop_id: "SH", channel: "youzan_branch_offline", external_item_id: "1" } };
  assert.equal(evaluateSalesIntentTask(task, ok).verdict, "proceed");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, intent: { enabled: true, version: 3 } }).verdict, "supersede");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, salesState: "sold" }).verdict, "supersede");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, stockQty: 0 }).verdict, "supersede");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, readFailed: true }).verdict, "block");
  const delist = { ...own, action: "delist", request_payload: { source: "sales_channel_intent", intent_version: 2 } };
  assert.equal(evaluateSalesIntentTask(delist, { ...ok, intent: { enabled: false, version: 2 }, salesState: "sold", stockQty: 0 }).verdict, "proceed");
});

test("0119 worker ownership: location/task/listing shop, sku, channel and active shop must all match", () => {
  const own = { sku_id: "S", shop_id: "SH", channel: "youzan_branch_offline", channel_listing_id: "CL" };
  const task = { ...own, action: "shelf", request_payload: { source: "sales_channel_intent", intent_version: 1, location_id: "L" } };
  const ok = { intent: { enabled: true, version: 1 }, salesState: "active", stockQty: 1,
    location: { shop_id: "SH", is_active: true, kind: "shop" }, shopActive: true,
    listing: { sku_id: "S", shop_id: "SH", channel: "youzan_branch_offline", external_item_id: "1" } };
  assert.equal(evaluateSalesIntentTask(task, ok).verdict, "proceed");
  // 库位已改绑到新店：旧店任务不得写新店
  assert.equal(evaluateSalesIntentTask(task, { ...ok, location: { ...ok.location, shop_id: "NEW" } }).verdict, "block");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, listing: { ...ok.listing, shop_id: "NEW" } }).verdict, "block");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, listing: { ...ok.listing, sku_id: "OTHER" } }).verdict, "block");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, listing: { ...ok.listing, channel: "youzan_hq" } }).verdict, "block");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, location: { ...ok.location, is_active: false } }).verdict, "block");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, shopActive: false }).verdict, "block");
  assert.equal(evaluateSalesIntentTask(task, { ...ok, listing: null }).verdict, "block");
  assert.equal(evaluateSalesIntentTask({ ...task, channel_listing_id: null }, ok).verdict, "block");
  // 共享 item：不写
  assert.equal(evaluateSalesIntentTask(task, { ...ok, shared: true }).verdict, "supersede");
});

test("0119 shared youzan item blocks both directions with Chinese reason; single mapping unaffected", () => {
  const f = { stockQty: 1, salesState: "active", listing: null, shop: { bound: true, authorized: true },
    youzan: { external_item_id: "9", listing_status: "published", last_verified_at: null }, youzanPending: false, intents: [] };
  assert.deepEqual(channelBlocks("youzan", { ...f, youzanShared: true }), { enable: "youzan_shared_item", disable: "youzan_shared_item" });
  assert.deepEqual(channelBlocks("youzan", f), { enable: null, disable: null });
  assert.equal(reasonLabel("youzan_shared_item"), "该商品为多规格共享收银商品，暂不能单独设置有赞渠道");
  const plan = planSkuChanges({ ...f, youzanShared: true }, [], ["app", "youzan"]);
  assert.equal(plan.skipReason, "youzan_shared_item");
  assert.deepEqual(plan.changes, {});
});

test("0119 aggregate: atomic SKU failure reports the real reason plus not-modified", () => {
  const r = aggregateBySku(["a"], [
    { sku_id: "a", channel: "app", success: false, reason: "sku_not_modified" },
    { sku_id: "a", channel: "youzan", success: false, reason: "version_conflict" },
  ]);
  assert.equal(r[0].success, false);
  assert.equal(r[0].reason, "商品渠道已被他人修改，请刷新后重试；该商品未修改");
});

test("0119 return restore: stock-only write is not a shelf check; shelf write still checks closed channel", () => {
  const restore = { action: "restore_after_return", request_payload: {} };
  assert.equal(writeRecheckPlan(restore, "stock", false), "stock_only");
  assert.equal(writeRecheckPlan(restore, "shelf", false), "legacy_shelf");
  assert.equal(writeRecheckPlan({ action: "shelf" }, "shelf", false), "legacy_shelf");
  assert.equal(writeRecheckPlan({ action: "set_stock_zero" }, "stock", true), "zeroing");
  assert.equal(writeRecheckPlan({ action: "set_stock" }, "stock", false), "none");
  assert.equal(writeRecheckPlan({ action: "delist", request_payload: { source: "sales_channel_intent" } }, "shelf", false), "intent");
});

test("batch aggregate per sku and fingerprint is order independent", () => {
  const r = aggregateBySku(["a", "b"], [
    { sku_id: "a", channel: "app", success: true, status: "applied" },
    { sku_id: "b", channel: "app", success: false, reason: "version_conflict" },
  ]);
  assert.deepEqual(r[0], { sku_id: "a", success: true, status: "applied" });
  const withSkip = aggregateBySku(["a", "z"], [{ sku_id: "a", channel: "app", success: true, status: "applied" }], [{ sku_id: "z", reason: "not_in_store" }]);
  assert.deepEqual(withSkip.map((x) => [x.sku_id, x.success, x.status]), [["a", true, "applied"], ["z", false, "skipped"]]);
  assert.match(r[1].reason!, /刷新/);
  assert.equal(
    singleRequestFingerprint("s", [{ channel: "app", enabled: true, expected_version: 0 }, { channel: "miniapp", enabled: false, expected_version: 1 }]),
    singleRequestFingerprint("s", [{ channel: "miniapp", enabled: false, expected_version: 1 }, { channel: "app", enabled: true, expected_version: 0 }]),
  );
});
