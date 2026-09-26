// systemd loads the protected EnvironmentFile. Never put credentials in argv or logs.
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.ERP_PORT ?? "3005";
if (!token || (port !== "3005" && port !== "3006")) {
  console.error("Listing image worker is not configured");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/public/hooks/listing-image-worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ limit: 2 }),
      redirect: "error",
      signal: AbortSignal.timeout(240000),
    });
    const data = await response.json();
    const count = data?.data?.processed;
    const processed = Number.isInteger(count) && count >= 0 && count <= 12 ? count : null;
    const failedCount = data?.data?.failed === undefined ? 0 : data.data.failed;
    const failed =
      Number.isInteger(failedCount) && failedCount >= 0 && failedCount <= 12 ? failedCount : null;
    const ok = response.status === 200 && data?.ok === true && processed !== null && failed === 0;
    const code = ok
      ? null
      : failed !== null && failed > 0
        ? "partial_failure"
        : ["worker_disabled", "unauthorized", "worker_failed"].includes(data?.code)
          ? data.code
          : "unexpected_response";
    console.log(JSON.stringify({ ok, status: response.status, processed, failed, code }));
    if (!ok) process.exitCode = 1;
  } catch {
    console.error(
      "Listing image worker request failed or timed out; durable jobs remain recoverable",
    );
    process.exitCode = 1;
  }
}
