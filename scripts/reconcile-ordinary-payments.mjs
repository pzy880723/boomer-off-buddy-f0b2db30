// systemd supplies the server environment; no token is exposed in argv or logs.
const token = process.env.WECHAT_ORDINARY_RECONCILE_TOKEN;
if (!token || token.length < 32) {
  console.error('Ordinary reconciliation is not configured');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch('http://127.0.0.1:3005/api/internal/payments/reconcile', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(170000),
    });
    const data = await response.json();
    console.log(JSON.stringify({ ok: response.ok && data.ok === true,
      attempted: Number.isInteger(data.attempted) ? data.attempted : null,
      succeeded: Number.isInteger(data.succeeded) ? data.succeeded : null,
      failed: Number.isInteger(data.failed) ? data.failed : null }));
    if (!response.ok || data.ok !== true) process.exitCode = 1;
  } catch { console.error('Ordinary reconciliation request failed; inspect the ledger, do not recreate payments'); process.exitCode = 1; }
}
