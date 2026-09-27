# Youzan Image Refresh: Candidate Handoff

Local implementation only. No production migration, API write, backfill, or deployment was executed by the image-worker task.

## Frozen Migration

`supabase/migrations/20260927190000_youzan_image_refresh.sql`

SHA-256: `6cefb480e73953d3ded600238a9713e31c31c1483690654851a34462c61778dd`

- Image-path/image-URL updates atomically enqueue a per-SKU/shop revision, including manual edits and AI completion RPC updates.
- Published listing inserts/updates force a latest-image pass, including unchanged late-publisher upserts.
- Single claim, ten-minute lease, expiry recovery, revision/token completion checks, bounded backoff, replay-safe finish.
- Archive/delist/missing mapping/shared master checks cancel without publishing, recreating, or touching quantity. Cancellation reasons are retained.
- No automatic backfill. Main task owns migration application and the reviewed ten-SKU repair set after canary.

## Hook Contract

`POST /api/public/hooks/youzan-image-refresh-worker`

- Authorization: service-role Bearer, supplied by the protected runner environment; never put it in an artifact.
- Body: `{ "limit": 1 }` for canary, default 2, bounded to 1..6.
- Enabled only when `YOUZAN_IMAGE_REFRESH_WORKER_ENABLED=true`, `PORT=3005`, and `HANDHELD_LISTING_IMAGE_WORKER_ENABLED` is not `false`.
- Response: `{ "ok": true, "data": { "claimed": 1, "failed": 0, "outcomes": [{ "id": "...", "status": "succeeded" }] } }`.
- Unauthorized: 401. Disabled/candidate: 503. Retryable/finish failure: 500, `ok:false`.
- Successful outbox `result` contains `images_synced` and `images_omitted`. Five is the explicit Youzan channel cap; preserve source order and cover, leave ERP's sixth image untouched.
- Runner/systemd/startup/deploy script are owned by main, not this task.

Release integration: `await enqueueYouzanImageRefresh(skuId, shopId)` exported from `src/server/youzan-image-refresh.server.ts`, after successful remote release and local link/listing persistence. Main owns this call site. Do not swallow enqueue failures as verified synchronization.

## Verified API Boundary

Official documentation read on 2026-09-27:

- [Edit product](https://doc.youzanyun.com/v2/doc/cloud/token/Sp5ewj9cfinIjSk6bkLcBP9ZnVh.md): `youzan.item.common.update`, `1.0.0`. HQ supported; chain branches are not. Optional omitted fields are unchanged; media uses upload-returned image IDs.
- [Product detail](https://doc.youzanyun.com/v2/doc/cloud/token/Y5PAw1Tgji2ftjkRxsTcAOVvnvg.md): `youzan.item.itemdetail.get`, `1.0.0`; `media.images` contains image ID and URL; library `item_id` differs from `channel_item_id`.
- [Legacy offline update](https://doc.youzanyun.com/v2/doc/cloud/token/Uh7Owam9ditWv4kBnUNc150gn8f.md): `photo_url`, maximum five; only retail single-store documented. NOT used as a fallback.
- [HQ SPU update](https://doc.youzanyun.com/v2/doc/cloud/token/R7PNwqVHWiIpx4kkhnjcZc6inGe.md): documented `photo_url` JSON URL array. Existing HQ preparation now supplies all selected images rather than just index zero, retaining the existing five-image channel cap.

Refresh mutation, HQ token only:

```json
{
  "method": "youzan.item.common.update",
  "version": "1.0.0",
  "params": {
    "item_id": "LIVE_HQ_CHANNEL_0_ITEM_ID_AS_NUMBER",
    "media": { "image_ids": ["UPLOAD_IMAGE_IDS_AS_NUMBERS"] },
    "is_stock_num_edited": false
  }
}
```

The adapter obtains the actual master code by the HQ link's SPU ID (not ERP SKU code), then resolves HQ channel-0 `item_id`. It verifies target branch code, library relationship, channel ID, and ERP barcode. Before HQ mutation it live-queries every other active configured branch using the exact master code and rejects visible or unverified responses. It never obtains a branch token for mutation.

No `stocks`, `skus`, `specs`, `display`, price, release, channel-publish, cancel, or shelf fields/calls. Missing/deleted branch is not recreated. Revision eligibility is checked before remote write and after readback. Slow old publishers must enqueue on completion; the queue provides eventual convergence, not a cross-system atomic transaction.

## Local Evidence and Release Gaps

- `node scripts/test-youzan-image-outbox.mjs`: in-memory PostgreSQL passes; no production connection.
- `node --experimental-strip-types --test src/server/youzan-image-refresh.test.ts src/server/youzan-image-media.test.ts`: 10 passing tests, including live-other-branch rejection and exact HQ request identity.
- Image/media/runner combined verification: 23 tests passed (includes Sagan's ten compression/strict-failure tests and main's three runner tests).
- `node scripts/test-youzan-stock.mjs`: 44 existing stock/offline regression tests passed.
- No production canary by this task. Main must configure and verify `PUBLIC_APP_ORIGIN` against the Tencent media endpoint, enqueue one reviewed pair, then verify HQ + target images and all-store quantity/visibility before any ten-SKU repair.
- HQ-to-branch inheritance is not assumed successful: mismatch remains retryable; no unsupported branch-write fallback. API acceptance is not proof of readback or all-store preservation.
- Initial Tencent build exposed client-side `sharp` reachability; Sagan owns its server-only correction and final build evidence. New hook route registration was generated locally.
