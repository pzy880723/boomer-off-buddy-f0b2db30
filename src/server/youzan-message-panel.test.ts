import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../components/youzan/message-push-panel.tsx", import.meta.url), "utf8");
const stats = readFileSync(new URL("../lib/youzan-message-push.functions.ts", import.meta.url), "utf8");

test("message setup points at Tencent and includes both member asset subscriptions", () => {
  assert.ok(panel.includes("https://erp.boomeroff.com/api/public/hooks/youzan-message"));
  assert.ok(!panel.includes("boomer-off-buddy.lovable.app"));
  assert.ok(panel.includes('code: "POINTS"'));
  assert.ok(panel.includes('code: "COUPON_CUSTOMER_PROMOTION"'));
  assert.ok(!panel.includes("勾选下面 4 个事件"));
  assert.ok(!panel.includes("有赞推送正常"));
});

test("message status also reads the member inbox under the user's RLS session", () => {
  assert.ok(stats.includes('.from("youzan_member_asset_inbox")'));
  assert.ok(stats.includes("assetLogs"));
  assert.ok(!stats.includes("supabaseAdmin"));
  assert.ok(!stats.includes('select("*"'));
  assert.ok(!stats.includes("payload"));
});
