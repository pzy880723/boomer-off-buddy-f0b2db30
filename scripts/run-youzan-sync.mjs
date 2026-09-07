// systemd supplies a protected EnvironmentFile; never pass or print this key in argv/logs.
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.ERP_PORT ?? '3005';
if (!token || (port !== '3005' && port !== '3006')) {
  console.error('Youzan sync is not configured');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/public/hooks/youzan-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ days: 3, slices: 3 }),
      redirect: 'error',
      signal: AbortSignal.timeout(590000),
    });
    const data = await response.json();
    const ok = response.ok && response.status !== 207 && data?.ok === true;
    console.log(JSON.stringify({ ok, status: response.status,
      order_windows: Number.isInteger(data?.order_windows) ? data.order_windows : null }));
    if (!ok) process.exitCode = 1;
  } catch {
    console.error('Youzan sync request failed; inspect queue progress before retrying');
    process.exitCode = 1;
  }
}
