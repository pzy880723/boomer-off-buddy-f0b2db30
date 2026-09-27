const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.ERP_PORT ?? "3005";
if (!token || port !== "3005") {
  console.error("Image refresh worker requires the production loopback configuration");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/public/hooks/youzan-image-refresh-worker`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ limit: 2 }), redirect: "error", signal: AbortSignal.timeout(590000),
    });
    const body = await response.json();
    const claimed = body?.data?.claimed, failed = body?.data?.failed;
    const valid = Number.isInteger(claimed) && claimed >= 0 && claimed <= 2
      && Number.isInteger(failed) && failed >= 0 && failed <= claimed;
    const ok = response.status === 200 && body?.ok === true && valid && failed === 0;
    console.log(JSON.stringify({ ok, status: response.status, claimed: valid ? claimed : null, failed: valid ? failed : null }));
    if (!ok) process.exitCode = 1;
  } catch {
    console.error("Image refresh request failed; inspect the durable queue before retrying");
    process.exitCode = 1;
  }
}
