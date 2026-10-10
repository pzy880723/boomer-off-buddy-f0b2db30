// systemd loads the protected EnvironmentFile; credentials never enter argv or logs.
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!token) {
  console.error("Custom card worker is not configured");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch("http://127.0.0.1:3005/api/public/hooks/custom-print-card-worker", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    });
    const body = await response.json();
    const counts = Object.fromEntries(["claimed", "ready", "failed", "stale"].map(
      (key) => [key, body?.data?.[key]],
    ));
    const valid = Object.values(counts).every((n) => Number.isInteger(n) && n >= 0 && n <= 1) &&
      counts.claimed === counts.ready + counts.failed + counts.stale;
    const ok = response.status === 200 && body?.ok === true && valid;
    console.log(JSON.stringify({ ok, status: response.status, ...(valid ? counts : {}) }));
    if (!ok) process.exitCode = 1;
  } catch {
    console.error("Custom card worker request failed; durable jobs remain recoverable");
    process.exitCode = 1;
  }
}
