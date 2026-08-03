#!/usr/bin/env node

const execute = process.argv.includes("--execute");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const endpoint =
  process.env.ERP_STANDARD_CATALOG_SYNC_URL ??
  "https://erp.boomeroff.com/api/public/hooks/youzan-standard-catalog-sync";

if (!key) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
}

let offset = 0;
let total = Number.POSITIVE_INFINITY;
let failed = 0;

while (offset < total) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dry_run: !execute,
      confirm: execute ? "SYNC_STANDARD_CATALOG" : "",
      limit: 20,
      offset,
      target_stock: 9999,
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`sync request failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  total = Number(payload.batch?.total ?? 0);
  offset = Number(payload.batch?.next_offset ?? total);
  failed += Number(payload.failed ?? 0);
  console.log(
    JSON.stringify({
      dry_run: payload.dry_run,
      processed: offset,
      total,
      batch_failed: payload.failed ?? 0,
      next_offset: offset,
    }),
  );
  if (Number(payload.failed ?? 0) > 0) break;
  if (!payload.batch?.has_more) break;
}

if (failed > 0) process.exitCode = 1;
