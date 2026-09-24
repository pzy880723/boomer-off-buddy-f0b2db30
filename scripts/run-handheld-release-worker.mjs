// systemd supplies a protected EnvironmentFile; never pass or print this key in argv/logs.
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.ERP_PORT ?? '3005';
if (!token || (port !== '3005' && port !== '3006')) {
  console.error('Handheld release worker is not configured');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/public/hooks/handheld-release-worker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ limit: 1 }),
      redirect: 'error',
      signal: AbortSignal.timeout(590000),
    });
    const data = await response.json();
    const ok = response.ok && data?.ok === true;
    console.log(JSON.stringify({ ok, status: response.status, claimed: data?.data?.claimed ?? null,
      outcomes: Array.isArray(data?.data?.outcomes) ? data.data.outcomes.map((o) => o.status) : null }));
    if (!ok) process.exitCode = 1;
  } catch {
    console.error('Handheld release worker request failed; outbox rows keep their lease and will be retried');
    process.exitCode = 1;
  }
}
