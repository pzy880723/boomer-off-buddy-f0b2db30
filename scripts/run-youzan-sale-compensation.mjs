// systemd oneshot：有界近期有赞销售补偿。凭证仅来自 EnvironmentFile，不写入 argv/日志。
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.ERP_PORT ?? "3005";
if (!token || (port !== "3005" && port !== "3006")) {
  console.error("Youzan sale compensation is not configured");
  process.exitCode = 1;
} else {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/public/hooks/youzan-sale-compensation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ window_hours: 48, limit: 30 }),
      redirect: "error",
      signal: AbortSignal.timeout(240000),
    });
    const j = await res.json().catch(() => null);
    const d = j?.data ?? {};
    const pick = (k) => (Number.isInteger(d[k]) && d[k] >= 0 ? d[k] : null);
    const ok = res.status === 200 && j?.ok === true;
    console.log(JSON.stringify({ ok, status: res.status, code: ok ? null : (j?.code ?? "unexpected_response"),
      scanned: pick("scanned"), committed: pick("committed"), already: pick("already"),
      skipped: pick("skipped"), unmatched: pick("unmatched"), failed: pick("failed") }));
    if (!ok) process.exitCode = 1;
  } catch {
    console.error("Youzan sale compensation request failed or timed out; sale events remain idempotent and retryable");
    process.exitCode = 1;
  }
}
