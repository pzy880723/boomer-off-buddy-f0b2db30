#!/usr/bin/env node
// 客服超时升级 worker（幂等，使用数据库时间）：60 秒未领取 / 180 秒未有效回复 → 标记总部升级。
// 不自带排程。启用：腾讯 systemd timer / crontab 每 15–30 秒调用一次：
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/run-support-escalation.mjs
// 只输出 escalated 数量与 checked_at；不打印会话 id、客户信息或原始错误响应。
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("support-escalation: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
function threshold(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 10 || n > 3600) {
    console.error(`support-escalation: ${name} must be an integer between 10 and 3600`);
    process.exit(2);
  }
  return n;
}
const unclaimed = threshold("SUPPORT_UNCLAIMED_SECONDS", 60);
const reply = threshold("SUPPORT_REPLY_SECONDS", 180);
let res;
try {
  res = await fetch(`${url}/rest/v1/rpc/support_escalate_overdue`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      apikey: key,
      ...(key.startsWith("sb_") ? {} : { Authorization: `Bearer ${key}` }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_unclaimed_seconds: unclaimed, p_reply_seconds: reply }),
  });
} catch (e) {
  console.error(`support-escalation: request failed (${e?.name === "TimeoutError" ? "timeout" : "network"})`);
  process.exit(1);
}
if (!res.ok) {
  console.error(`support-escalation: HTTP ${res.status}`);
  process.exit(1);
}
let body;
try {
  body = await res.json();
} catch {
  console.error("support-escalation: invalid JSON response");
  process.exit(1);
}
if (!body || !Number.isInteger(body.escalated) || typeof body.checked_at !== "string") {
  console.error("support-escalation: unexpected response shape");
  process.exit(1);
}
console.log(JSON.stringify({ escalated: body.escalated, checked_at: body.checked_at }));
