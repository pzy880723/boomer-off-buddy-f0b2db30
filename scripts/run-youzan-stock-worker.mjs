// systemd supplies the protected EnvironmentFile; never log credentials or raw errors.
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.ERP_PORT ?? "3005";
if (!token || port !== "3005") {
  console.error("Youzan stock worker is not configured for production loopback");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/public/hooks/youzan-stock-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ limit: 1 }),
      redirect: "error",
      signal: AbortSignal.timeout(590000),
    });
    const body = await response.json();
    const count = value => Number.isInteger(value) && value >= 0 && value <= 1 ? value : null;
    const processed = count(body?.data?.processed), failed = count(body?.data?.failed);
    const valid = processed !== null && failed !== null && failed <= processed;
    const ok = response.status === 200 && body?.ok === true && valid && failed === 0;
    const code = ok ? null : valid && failed > 0 ? "partial_failure"
      : ["unauthorized", "worker_disabled", "worker_failed"].includes(body?.code) ? body.code : "unexpected_response";
    console.log(JSON.stringify({ ok, status: response.status, processed, failed, code }));
    if (!ok) process.exitCode = 1;
  } catch {
    console.error("Youzan stock worker request failed or timed out; inspect queue state before retrying");
    process.exitCode = 1;
  }
}
