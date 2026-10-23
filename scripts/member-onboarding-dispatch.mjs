import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function selectDueJobs(rows, now = Date.now()) {
  return [...new Set(rows.filter(row => /^[0-9a-f-]{36}$/i.test(row.shop_id)
    && (row.status === 'queued' || (row.status === 'running' && Date.parse(row.lease_until) < now)
      || (row.status === 'blocked' && row.reason === 'worker_unavailable'
        && Number.isInteger(row.attempts) && row.attempts > 0 && row.attempts < 3
        && row.checks?.transientRetryEligible === true && Date.parse(row.retry_after) <= now)))
    .map(row => row.shop_id))].slice(0, 4);
}
export function dueJobQuery(now = Date.now()) {
  return new URLSearchParams({
    select: 'shop_id,status,lease_until,reason,attempts,retry_after,checks',
    or: `(status.eq.queued,and(status.eq.running,lease_until.lt.${new Date(now).toISOString()}),and(status.eq.blocked,reason.eq.worker_unavailable,attempts.gt.0,attempts.lt.3,checks->>transientRetryEligible.eq.true,retry_after.lte.${new Date(now).toISOString()}))`,
    order: 'created_at', limit: '4',
  });
}
export async function dispatchJobs(deps) {
  const ids = selectDueJobs(await deps.list());
  let failed = 0;
  for (const id of ids) {
    try { await deps.run(id); } catch { failed++; }
  }
  return { attempted: ids.length, failed };
}
async function main() {
  const env = process.env;
  assert.equal(env.BOOMER_RUNTIME, 'tencent');
  assert.equal(env.MEMBER_ONBOARDING_ENABLED, 'true');
  assert.ok(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.YOUZAN_PROXY_URL && env.YOUZAN_PROXY_TOKEN);
  const result = await dispatchJobs({
    async list() {
      const params = dueJobQuery();
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/member_onboarding_jobs?${params}`, {
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(20000),
      });
      assert.ok(r.ok, 'onboarding_queue_unavailable');
      const rows = await r.json(); assert.ok(Array.isArray(rows)); return rows;
    },
    run(id) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./run-member-onboarding.mjs', import.meta.url)), id], { stdio: 'inherit', signal: AbortSignal.timeout(120000) });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(Error('onboarding_child_failed')));
      });
    },
  });
  console.log(JSON.stringify({ ...result, phase: 'onboarding_dispatch', assetWrites: 0 }));
  if (result.failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(() => { console.error('member_onboarding_dispatch_failed'); process.exitCode = 1; });
}