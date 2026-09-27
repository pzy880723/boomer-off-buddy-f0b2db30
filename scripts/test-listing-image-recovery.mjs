import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// In-memory PostgreSQL only. No credentials, network, or production mutations.
const db = new PGlite();
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const source = "sku-raw/front.jpg";
const sql = name => readFile(new URL(name, import.meta.url), "utf8");
before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE inv_brands(id uuid PRIMARY KEY);
    CREATE TABLE inv_sku_classifications(id uuid PRIMARY KEY);
    CREATE TABLE inv_skus(id uuid PRIMARY KEY,status text DEFAULT 'active',image_paths text[],image_url text,updated_at timestamptz);
    CREATE TABLE commerce_listings(sku_id uuid,status text,image_paths jsonb,updated_at timestamptz);
    CREATE SCHEMA storage; CREATE TABLE storage.objects(bucket_id text,name text);`);
  await db.exec(await sql("../supabase/migrations/20260831190000_handheld_async_listing_images.sql"));
  const apply = (await sql("../drizzle/migrations/0016_handheld_item_images.sql"))
    .match(/CREATE OR REPLACE FUNCTION public\.handheld_apply_listing_image_result\([\s\S]*?\n\$\$;/);
  assert.ok(apply);
  await db.exec(apply[0]);
  await db.exec(await sql("../supabase/migrations/20260927092334_handheld_listing_image_recovery.sql"));
  await db.exec(`GRANT USAGE ON SCHEMA public,storage TO service_role;
    GRANT SELECT,UPDATE ON inv_skus,commerce_listings TO service_role;
    GRANT SELECT ON storage.objects TO service_role;`);
});
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE inv_listing_image_jobs,inv_skus,commerce_listings,storage.objects;");
  await db.query("INSERT INTO inv_skus(id,image_paths) VALUES($1,$2)", [id(1), [source, "sku-listing/keep.png"]]);
  await db.query("INSERT INTO commerce_listings VALUES($1,'published',$2,now())", [id(1), JSON.stringify([source, "sku-listing/keep.png"])]);
  await db.query("INSERT INTO inv_listing_image_jobs(id,sku_id,source_bucket,source_path) VALUES($1,$2,'sku-raw','front.jpg')", [id(2), id(1)]);
});
after(async () => { await db.close(); });
const claim = () => db.query("SELECT * FROM handheld_listing_image_claim(2)").then(r => r.rows);
const job = () => db.query("SELECT * FROM inv_listing_image_jobs WHERE id=$1", [id(2)]).then(r => r.rows[0]);
const sku = () => db.query("SELECT * FROM inv_skus WHERE id=$1", [id(1)]).then(r => r.rows[0]);
const target = j => `sku-listing/gallery/${j.sku_id}/${j.id}/${j.claim_token}.png`;
const upload = j => db.query("INSERT INTO storage.objects VALUES('sku-listing',$1)", [target(j).slice("sku-listing/".length)]);
const finish = (j, error = null, path = target(j)) => db.query(
  "SELECT handheld_listing_image_finish($1,$2,$3,$4) AS status", [j.id, j.claim_token, path, error],
).then(r => r.rows[0].status);
const expire = () => db.exec("UPDATE inv_listing_image_jobs SET lease_until=now()-interval '1 second'");

test("claim is exclusive, increments attempts, and exposes processing atomically", async () => {
  const [j] = await claim();
  assert.equal(j.attempts, 1); assert.ok(j.claim_token); assert.ok(j.lease_until);
  assert.equal((await claim()).length, 0);
  assert.equal((await sku()).image_processing_status, "processing");
});
test("pre-migration crashed jobs with only locked_at recover", async () => {
  await db.exec("UPDATE inv_listing_image_jobs SET status='processing',attempts=1,locked_at=now()-interval '6 minutes',locked_by='old'");
  const [j] = await claim(); assert.equal(j.attempts, 2); assert.ok(j.claim_token);
});
test("live old-format claims are not stolen", async () => {
  await db.exec("UPDATE inv_listing_image_jobs SET status='processing',locked_at=now(),locked_by='old'");
  assert.equal((await claim()).length, 0);
});
test("legacy processing without lock metadata is recoverable", async () => {
  await db.exec("UPDATE inv_listing_image_jobs SET status='processing',attempts=1,locked_at=NULL");
  const [j] = await claim(); assert.equal(j.attempts, 2); assert.ok(j.claim_token);
});
test("expired owner cannot apply images even before a successor claims", async () => {
  const [j] = await claim(); await upload(j); await expire();
  assert.equal(await finish(j), "stale");
  assert.equal((await sku()).image_paths[0], source);
});
test("finish rejects wall-clock expiry even when its transaction started before expiry", async () => {
  const [j] = await claim(); await upload(j);
  await db.exec("BEGIN");
  try {
    await db.exec("UPDATE inv_listing_image_jobs SET lease_until=clock_timestamp()+interval '100 milliseconds'");
    await new Promise(resolve => setTimeout(resolve, 350));
    const clocks = (await db.query("SELECT lease_until<=clock_timestamp() AS expired,lease_until>now() AS transaction_live FROM inv_listing_image_jobs")).rows[0];
    assert.deepEqual(clocks, { expired: true, transaction_live: true });
    assert.equal(await finish(j), "stale");
    assert.equal((await sku()).image_paths[0], source);
  } finally { await db.exec("ROLLBACK"); }
});
test("reclaimed owner fences the old apply and finish, including late errors", async () => {
  const [old] = await claim(); await upload(old); await expire();
  const [next] = await claim(); assert.notEqual(next.claim_token, old.claim_token); await upload(next);
  assert.equal(await finish(old), "stale");
  assert.equal(await finish(next), "succeeded");
  assert.equal(await finish(old, "late failure"), "stale");
  assert.equal((await sku()).image_paths[0], target(next));
  assert.equal((await job()).status, "succeeded");
});
test("completion preserves current ordering and other manually replaced images", async () => {
  const [j] = await claim(); await upload(j);
  await db.query("UPDATE inv_skus SET image_paths=$1 WHERE id=$2", [["sku-listing/manual.png", source], id(1)]);
  assert.equal(await finish(j), "succeeded");
  assert.deepEqual((await sku()).image_paths, ["sku-listing/manual.png", target(j)]);
  assert.equal((await sku()).image_processing_status, "succeeded");
  const listing = (await db.query("SELECT image_paths FROM commerce_listings")).rows[0];
  assert.deepEqual(listing.image_paths, [target(j), "sku-listing/keep.png"]);
  assert.equal(await finish(j), "stale", "replayed completion cannot reapply");
});
test("removed raw source is never resurrected or acknowledged as applied", async () => {
  const [j] = await claim(); await upload(j);
  await db.query("UPDATE inv_skus SET image_paths=$1 WHERE id=$2", [["sku-listing/replacement.png"], id(1)]);
  assert.equal(await finish(j), "permanent_failed");
  assert.equal((await job()).last_error, "source_removed_not_applied");
  assert.deepEqual((await sku()).image_paths, ["sku-listing/replacement.png"]);
  assert.equal((await sku()).image_processing_status, "retryable_failed");
});
test("removed source is rejected before spending AI work", async () => {
  await db.exec("UPDATE inv_skus SET image_paths='{}'");
  assert.equal((await claim()).length, 0);
  assert.equal((await job()).last_error, "source_removed_not_applied");
  assert.equal((await sku()).image_processing_status, "retryable_failed");
});
test("deleted SKU cascades its job and rejects late completion", async () => {
  const [j] = await claim(); await upload(j);
  await db.query("DELETE FROM inv_skus WHERE id=$1", [id(1)]);
  assert.equal(await finish(j), "stale");
  assert.equal(await job(), undefined);
});
test("sibling finishes compute current aggregate state rather than stale summaries", async () => {
  await db.query("UPDATE inv_skus SET image_paths=$1", [[source, "sku-raw/back.jpg"]]);
  await db.query("INSERT INTO inv_listing_image_jobs(id,sku_id,source_bucket,source_path) VALUES($1,$2,'sku-raw','back.jpg')", [id(3), id(1)]);
  const jobs = await claim(); assert.equal(jobs.length, 2);
  await upload(jobs[0]); await finish(jobs[0]);
  assert.equal((await sku()).image_processing_status, "processing");
  await finish(jobs[1], "upstream unavailable", null);
  assert.equal((await sku()).image_processing_status, "partial_failed");
});
test("archived SKU is not updated on late completion", async () => {
  const [j] = await claim(); await upload(j); await db.exec("UPDATE inv_skus SET status='archived'");
  assert.equal(await finish(j), "permanent_failed");
  assert.equal((await sku()).image_paths[0], source);
});
test("completion DB failure rolls back image replacement and job status together", async () => {
  const [j] = await claim(); await upload(j);
  await db.exec(`CREATE FUNCTION reject_job_finish() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'fixture completion unavailable'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER reject_finish BEFORE UPDATE ON inv_listing_image_jobs FOR EACH ROW EXECUTE FUNCTION reject_job_finish();`);
  try {
    await assert.rejects(finish(j), /fixture completion unavailable/);
    assert.equal((await sku()).image_paths[0], source);
    assert.equal((await job()).status, "processing");
    assert.equal((await db.query("SELECT image_paths FROM commerce_listings")).rows[0].image_paths[0], source);
  } finally { await db.exec("DROP TRIGGER reject_finish ON inv_listing_image_jobs; DROP FUNCTION reject_job_finish()"); }
  await expire(); const [next] = await claim(); await upload(next);
  assert.equal(await finish(next), "succeeded");
});
test("failed preparation respects backoff and the existing five-attempt limit", async () => {
  const [j] = await claim(); assert.equal(await finish(j, "detector unavailable", null), "retryable_failed");
  assert.equal((await claim()).length, 0);
  await db.exec("UPDATE inv_listing_image_jobs SET attempts=4,next_run_at=now()");
  const [last] = await claim(); assert.equal(last.attempts, 5);
  assert.equal(await finish(last, "detector unavailable", null), "permanent_failed");
  assert.equal((await claim()).length, 0);
});
test("final-attempt crash becomes terminal and refreshes the SKU", async () => {
  await db.exec("UPDATE inv_listing_image_jobs SET attempts=4");
  await claim(); await expire();
  assert.equal((await claim()).length, 0);
  assert.equal((await job()).status, "permanent_failed");
  assert.equal((await sku()).image_processing_status, "retryable_failed");
});
test("wrong-owner or missing output objects cannot be accepted", async () => {
  const [j] = await claim();
  await assert.rejects(finish(j), /invalid_listing_image_target/);
  await assert.rejects(finish(j, null, "sku-listing/somebody-else.png"), /invalid_listing_image_target/);
  assert.equal((await sku()).image_paths[0], source);
  assert.equal((await job()).status, "processing");
});
test("null or mismatched owner cannot apply or finish a live job", async () => {
  const [j] = await claim(); await upload(j);
  assert.equal(await finish({ ...j, claim_token: null }, null, target(j)), "stale");
  assert.equal(await finish({ ...j, claim_token: id(99) }, null, target(j)), "stale");
  assert.equal((await job()).status, "processing");
  assert.equal((await sku()).image_paths[0], source);
});
test("RPC permissions deny public callers while service_role can complete", async () => {
  const [j] = await claim(); await upload(j);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(claim(), /permission denied/);
    await assert.rejects(finish(j), /permission denied/);
    await db.exec("RESET ROLE");
  }
  await db.exec("SET ROLE service_role");
  assert.equal(await finish(j), "succeeded");
  await db.exec("RESET ROLE");
});
