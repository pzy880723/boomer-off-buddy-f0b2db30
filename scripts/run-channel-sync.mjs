// Tencent localhost only. Credentials stay in environment and request headers.
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import assert from 'node:assert/strict';

export async function runChannelSync({ token, port = '3005', skuId, action }, request = fetch) {
  assert.ok(token && ['3005', '3006'].includes(port), 'Channel sync is not configured');
  assert.ok(!skuId || /^[a-f0-9-]{36}$/i.test(skuId), 'Invalid canary SKU');
  assert.ok(!action || ['set_stock_zero', 'delist'].includes(action), 'Invalid canary action');
  const results = [];
  for (const operation of action ? [action] : ['set_stock_zero', 'delist']) {
    const response = await request(`http://127.0.0.1:${port}/api/public/hooks/channel-sync-worker`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: operation, limit: skuId ? 1 : 5, lease_seconds: 300, ...(skuId ? { sku_id: skuId } : {}) }),
      redirect: 'error', signal: AbortSignal.timeout(240000),
    });
    const body = await response.json();
    const tasks = Array.isArray(body.results) ? body.results : [];
    results.push({ action: operation, ok: response.status === 200 && body.ok === true && tasks.every(x => x.ok === true),
      http: response.status, claimed: Number.isInteger(body.claimed) ? body.claimed : null,
      succeeded: tasks.filter(x => x.ok && x.status === 'succeeded').length,
      superseded: tasks.filter(x => x.ok && x.status === 'superseded').length,
      failed: tasks.filter(x => !x.ok).length });
  }
  return { ok: results.every(x => x.ok), results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const result = await runChannelSync({ token: process.env.SUPABASE_SERVICE_ROLE_KEY, port: process.env.ERP_PORT,
      skuId: process.env.CANARY_SKU_ID, action: process.env.CANARY_ACTION });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error('Channel sync failed or timed out; leased tasks remain retryable');
    process.exitCode = 1;
  }
}
