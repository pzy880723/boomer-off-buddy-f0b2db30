#!/usr/bin/env node

const execute = process.argv.includes("--execute");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const endpoint =
  process.env.ERP_STANDARD_CATALOG_SYNC_URL ??
  "https://erp.boomeroff.com/api/public/hooks/youzan-standard-catalog-sync";

if (!key) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
}

let offset = Math.max(0, Number(process.env.STANDARD_SYNC_START_OFFSET ?? 0) || 0);
let total = Number.POSITIVE_INFINITY;
let failed = 0;
const maxAttempts = 3;
const batchSize = Math.min(
  20,
  Math.max(1, Number(process.env.STANDARD_SYNC_BATCH_SIZE ?? 10) || 10),
);

while (offset < total) {
  let payload;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dry_run: !execute,
          confirm: execute ? "SYNC_STANDARD_CATALOG" : "",
          limit: batchSize,
          offset,
          target_stock: 9999,
        }),
      });
      const text = await response.text();
      payload = JSON.parse(text);
      if (!response.ok) {
        throw new Error(`sync request failed (${response.status}): ${JSON.stringify(payload)}`);
      }
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      console.warn(
        JSON.stringify({
          offset,
          attempt,
          request_error: error instanceof Error ? error.message.slice(0, 240) : String(error),
          retrying: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
      continue;
    }
    if (Number(payload.failed ?? 0) === 0 || attempt === maxAttempts) break;
    console.warn(JSON.stringify({ offset, attempt, batch_failed: payload.failed, retrying: true }));
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
  }
  if (!payload) throw new Error("standard catalog sync returned no payload");
  total = Number(payload.batch?.total ?? 0);
  const batchFailed = Number(payload.failed ?? 0);
  failed += batchFailed;
  const nextOffset = Number(payload.batch?.next_offset ?? total);
  console.log(
    JSON.stringify({
      dry_run: payload.dry_run,
      processed: nextOffset,
      total,
      batch_failed: batchFailed,
      next_offset: nextOffset,
    }),
  );
  if (batchFailed > 0) break;
  offset = nextOffset;
  if (!payload.batch?.has_more) break;
}

if (failed > 0) process.exitCode = 1;
