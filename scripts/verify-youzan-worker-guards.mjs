import assert from "node:assert/strict";
const base = process.argv[2];
const candidate = process.argv.includes("--candidate");
for (const endpoint of ["handheld-release-worker", "handheld-item-sync-worker", "listing-image-worker", "youzan-stock-worker", "youzan-image-refresh-worker"]) {
  const url = `${base}/api/public/hooks/${endpoint}`;
  for (const headers of [{}, { apikey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "invalid" }]) {
    const response = await fetch(url, { method: "POST", headers });
    assert.equal(response.status, 401, `${endpoint}: anonymous or public key must be rejected`);
  }
  if (candidate) {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
    assert.equal(response.status, 503, `${endpoint}: candidate must not run jobs`);
    assert.equal((await response.json()).code, "worker_disabled");
  }
}
console.log(JSON.stringify({ base, candidate, guards: "passed", productionJobsTriggered: false }));
