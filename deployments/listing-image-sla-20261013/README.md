# Photo touch-up SLA (0059, candidate, NOT applied)

The Lovable Cloud DB (sxddfcoiaboqcmeviykl) is the production DB that Tencent workers use, so applying this
changes live scheduling at once. Apply only after approval. Apply it through the migration tool, then remove this copy.

## What changes (functions only, signatures unchanged)
- gallery + detail lease 5min → 4min (matches the worker's 240s deadline). claim_token, version fencing and SKU→job lock order are unchanged.
- Retry backoff 30/300/1800/7200s → 10/30/60/60s. Attempt limit stays at 5.
- Permanent errors: if `p_error` starts with `permanent:` or `ai_consent_missing`, the job goes straight to `permanent_failed`, the original photo stays, and the job is never reported as succeeded.
- Claim order: SKU group (earliest created_at) → source_index (main photo first) → id. A 6-photo group is claimed in one call when limit = 6.
- Detail (content) image claims return nothing while any gallery job is due or reclaimable.
- Existing rows are NOT touched. The 3 production jobs already parked until 10:44–10:45 UTC keep their next_run_at; Codex re-queues them deliberately.

## 5-minute budget (per photo, all 6 in parallel)
| step | budget |
|---|---|
| timer pickup (OnUnitInactiveSec 60s → recommend 15–20s, or trigger right after enqueue) | ≤20s |
| download + measurement_detection 60s + image_generation 60s + image_validation 45s + upload | ≤180s typical |
| one fast retry (10s backoff + next tick) on a transient failure | needs headroom |

A full worst-case retry does not fit in 5 minutes. The SLA holds for first-attempt success plus at most one short retry, and only if the pickup tick is ≤20s and the stages usually finish well under their timeouts.

## Concurrency
- Worker `limit=6` per run (one listing's 6 photos at once). Run at most 1–2 worker instances, so ≤12 photos run at a time and ≤3 AI calls per photo are in flight.
- On 429, keep the job retryable (no `permanent:` prefix). The 60s backoff cap spreads the load. Do not raise concurrency beyond this without gateway rate-limit data.

## Test
`bash tests/sql/listing_image_sla/run.sh` → 10/10 on this candidate. The current live logic fails (stops at S2: detail images do not yield).
