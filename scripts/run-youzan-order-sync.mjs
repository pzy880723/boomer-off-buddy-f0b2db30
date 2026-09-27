// Order-only systemd runner. Credentials come from its protected EnvironmentFile.
const token = process.env.SUPABASE_SERVICE_ROLE_KEY;
const port = process.env.ERP_PORT ?? '3005';
if (!token || port !== '3005') {
  console.error('Youzan order sync is not configured for production loopback');
  process.exitCode = 1;
} else {
  const deadline = Date.now() + 240000;
  let calls = 0, upserted = 0, idle = false;
  try {
    const post = async body => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('budget_exhausted');
      const response = await fetch(`http://127.0.0.1:${port}/api/public/hooks/youzan-order-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.timeout(Math.min(body.action === 'enqueue' ? 10000 : 115000, remaining)),
      });
      const data = await response.json();
      if (response.status !== 200 || data?.ok !== true || data.action !== body.action || data.error != null) {
        throw Error('worker_failed');
      }
      return data.data;
    };
    const enqueued = await post({ action: 'enqueue', days: 1 });
    if (!Number.isInteger(enqueued?.shops) || enqueued.shops < 0 ||
        !Number.isInteger(enqueued?.windows) || enqueued.windows < 0) throw Error('invalid_enqueue');
    for (let i = 0; i < 3; i += 1) {
      const data = await post({ action: 'run', slices: 1, max_pages: 2 });
      calls += 1;
      if (!Array.isArray(data?.results) || data.results.length !== 1) throw Error('invalid_results');
      const r = data.results[0];
      if (!r || r.error != null || r.applied === false) throw Error('slice_failed');
      if (r.claimed === false && r.reason === 'idle' && r.status == null && r.applied == null) { idle = true; break; }
      if (r.claimed !== true || r.applied !== true || !['pending', 'done'].includes(r.status) ||
          !Number.isInteger(r.upserted) || r.upserted < 0) throw Error('slice_failed');
      upserted += r.upserted;
    }
    console.log(JSON.stringify({ ok: true, windows: enqueued.windows, calls, upserted, idle }));
  } catch {
    // Do not log raw upstream errors, order payloads, signed URLs or credentials.
    console.error(JSON.stringify({ ok: false, code: 'order_sync_failed', calls, upserted }));
    process.exitCode = 1;
  }
}
