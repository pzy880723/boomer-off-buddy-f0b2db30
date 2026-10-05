#!/usr/bin/env node
// 客服超时升级 worker（幂等，使用数据库时间）：60 秒未领取 / 180 秒未有效回复 → 标记总部升级。
// 不自带排程。启用方式：在腾讯服务器用 systemd timer 或 crontab 每 15–30 秒调用一次：
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/run-support-escalation.mjs
// 只输出数量与会话 id，不输出客户信息。
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
const unclaimed = Number(process.env.SUPPORT_UNCLAIMED_SECONDS ?? 60);
const reply = Number(process.env.SUPPORT_REPLY_SECONDS ?? 180);
const res = await fetch(`${url}/rest/v1/rpc/support_escalate_overdue`, {
  method: "POST",
  headers: {
    apikey: key,
    ...(key.startsWith("sb_") ? {} : { Authorization: `Bearer ${key}` }),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ p_unclaimed_seconds: unclaimed, p_reply_seconds: reply }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`support_escalate_overdue failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  process.exit(1);
}
console.log(text);
