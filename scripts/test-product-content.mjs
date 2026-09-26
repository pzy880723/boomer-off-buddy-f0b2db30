import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
// An in-memory PostgreSQL engine: no project credentials or network connections.
const db = new PGlite();
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE user_roles(user_id uuid,role text);
    CREATE TABLE inv_locations(id uuid PRIMARY KEY,is_active boolean DEFAULT true);
    CREATE TABLE user_location_perms(user_id uuid,location_id uuid);
    CREATE TABLE inv_skus(id uuid PRIMARY KEY,name text DEFAULT 'Cup',kind text DEFAULT 'single',
      is_custom_price boolean DEFAULT true,status text DEFAULT 'active',is_display boolean DEFAULT true,
      image_paths text[] DEFAULT '{}',notes text DEFAULT 'keep summary',stock_qty int DEFAULT 1);
    CREATE TABLE inv_stocks(sku_id uuid,location_id uuid,qty int,PRIMARY KEY(sku_id,location_id));
    CREATE TABLE commerce_listings(sku_id uuid,status text,description text DEFAULT 'keep listing summary');
    CREATE SCHEMA storage; CREATE TABLE storage.objects(bucket_id text,name text);
    CREATE FUNCTION has_role(uuid,text) RETURNS boolean LANGUAGE sql AS
      $$ SELECT EXISTS(SELECT 1 FROM user_roles WHERE user_id=$1 AND role=$2) $$;
    GRANT USAGE ON SCHEMA public,storage TO service_role;
    GRANT SELECT ON ALL TABLES IN SCHEMA public,storage TO service_role;
    GRANT UPDATE ON public.inv_skus TO service_role;
  `);
  const previous = await readFile(
    new URL("../drizzle/migrations/0015_handheld_item_edit_delete_v2.sql", import.meta.url),
    "utf8",
  );
  for (const name of ["handheld_item_fail", "handheld_item_actor"]) {
    const sql = previous.match(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
    );
    assert.ok(sql, `existing ${name}`);
    await db.exec(sql[0]);
  }
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const migration = (await readdir(dir)).find((name) => name.endsWith("_product_rich_content.sql"));
  assert.ok(migration, "CLI-generated product rich-content migration exists");
  await db.exec(await readFile(new URL(migration, dir), "utf8"));

  const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const hq = id(1),
    manager = id(2),
    staff = id(3),
    location = id(11),
    elsewhere = id(12),
    sku = id(21),
    device = id(31);
  const image = {
    id: "raw-detail",
    type: "image",
    storage_path: `sku-raw/2026-09-27/${device}/raw.jpg`,
  };
  await db.query(
    `INSERT INTO user_roles VALUES($1,'hq_operator'),($2,'store_manager'),($3,'store_staff')`,
    [hq, manager, staff],
  );
  await db.query(`INSERT INTO inv_locations(id) VALUES($1),($2)`, [location, elsewhere]);
  await db.query(`INSERT INTO user_location_perms VALUES($1,$3),($2,$3)`, [
    manager,
    staff,
    location,
  ]);
  await db.query(`INSERT INTO inv_skus(id) VALUES($1);`, [sku]);
  await db.query(`INSERT INTO inv_stocks VALUES($1,$2,0)`, [sku, location]);
  await db.query(`INSERT INTO storage.objects VALUES('sku-raw',$1)`, [image.storage_path.slice(8)]);
  const call = (body, user = hq, loc = location, dev = device, item = sku) =>
    db
      .query(`SELECT handheld_product_content($1,$2,$3,$4,$5::jsonb) AS result`, [
        dev,
        user,
        loc,
        item,
        JSON.stringify(body),
      ])
      .then((r) => r.rows[0].result);
  const save = (op, version, blocks = [image], publish = false) => ({
    action: "save",
    client_op_id: op,
    expected_version: version,
    blocks,
    publish,
  });
  const published = () =>
    db.query(`SELECT published_product_content($1) AS result`, [sku]).then((r) => r.rows[0].result);
  await db.exec("SET ROLE service_role");
  assert.deepEqual(await call({ action: "get" }), {
    version: 0,
    draft_blocks: [],
    published_blocks: [],
  });
  for (const action of ["get", "generate", "save"]) {
    const body = action === "save" ? save("denied-0001", 0) : { action };
    await assert.rejects(call(body, staff), /edit_forbidden/);
    await assert.rejects(call(body, manager, elsewhere), /location_forbidden/);
    await assert.rejects(call(body, null), /session_required/);
  }
  console.log("PASS authorization for every action, employee and location boundaries");
  const first = await call(save("save-0001", 0), manager);
  assert.equal(first.version, 1);
  assert.deepEqual(first.draft_blocks, [image]);
  assert.deepEqual(first.published_blocks, []);
  assert.equal(await published(), null);
  assert.equal(
    (await db.query(`SELECT count(*)::int n FROM inv_product_content_image_jobs`)).rows[0].n,
    0,
    "Draft-only save does not enqueue optimization",
  );
  const text = { id: "story", type: "paragraph", text: "A quiet moment at your desk." };
  const second = await call(save("save-0002", 1, [text, image], true));
  assert.equal(second.version, 2);
  assert.equal(
    (await db.query(`SELECT count(*)::int n FROM inv_product_content_image_jobs`)).rows[0].n,
    1,
    "Publishing atomically queues raw detail image",
  );
  assert.deepEqual(
    await call(save("save-0001", 0), manager),
    first,
    "Retry returns the exact original snapshot even after later saves",
  );
  for (const altered of [
    save("save-0001", 1),
    save("save-0001", 0, [], false),
    save("save-0001", 0, [image], true),
  ]) {
    await assert.rejects(call(altered, manager), /client_op_id_conflict/);
  }
  await assert.rejects(call(save("save-0001", 0), hq), /client_op_id_conflict/);
  await assert.rejects(call(save("stale-0001", 0)), /version_conflict/);
  await db.exec("RESET ROLE");
  await db.query(`DELETE FROM user_location_perms WHERE user_id=$1`, [manager]);
  await db.exec("SET ROLE service_role");
  await assert.rejects(call(save("save-0001", 0), manager), /location_forbidden/);
  console.log("PASS version conflict, exact-payload idempotency and reauthorization before replay");
  // Publishing content does not publish an inventory listing.
  assert.equal(await published(), null);
  await db.exec(
    `RESET ROLE; INSERT INTO commerce_listings(sku_id,status) SELECT id,'published' FROM inv_skus; SET ROLE service_role`,
  );
  assert.deepEqual(await published(), { version: 2, published_blocks: [text, image] });
  await call(save("save-0003", 2, [{ ...text, text: "PRIVATE DRAFT" }, image]));
  assert.deepEqual(await published(), { version: 2, published_blocks: [text, image] });
  console.log("PASS published-only snapshot and version do not leak later drafts");
  for (const patch of ["is_custom_price=false", "kind='bundle'", "status='archived'"]) {
    await db.exec(`RESET ROLE; UPDATE inv_skus SET ${patch}; SET ROLE service_role`);
    for (const action of ["get", "generate", "save"])
      await assert.rejects(
        call(action === "save" ? save("save-0002", 1, [text, image], true) : { action }),
        /custom_only|sku_archived/,
      );
    assert.equal(await published(), null);
    await db.exec(
      `RESET ROLE; UPDATE inv_skus SET is_custom_price=true,kind='single',status='active'; SET ROLE service_role`,
    );
  }
  await db.exec(`RESET ROLE; UPDATE inv_skus SET is_display=false; SET ROLE service_role`);
  assert.equal(await published(), null);
  await db.exec(`RESET ROLE; UPDATE inv_skus SET is_display=true; SET ROLE service_role`);
  const invalid = [
    [{ ...image, storage_path: "https://example.com/x.jpg" }],
    [{ ...image, storage_path: "sku-raw/a.jpg?token=x" }],
    [{ ...image, storage_path: "sku-raw/%2e%2e/x.jpg" }],
    [{ ...image, storage_path: "sku-raw/../x.jpg" }],
    [{ ...image, storage_path: "sku-raw/a\\b.jpg" }],
    [{ ...image, read_url: "https://signed" }],
    [image, image],
    [{ id: "bad", type: "paragraph", text: "<b>HTML</b>" }],
    [{ id: "bad", type: "paragraph", text: "https://signed" }],
    [{ id: "empty", type: "facts" }],
    [{ ...image, storage_path: `sku-raw/2026-09-27/${id(99)}/other.jpg` }],
  ];
  for (const blocks of invalid)
    await assert.rejects(call(save("invalid-01", 3, blocks)), /validation_error|image_forbidden/);
  await assert.rejects(call({ action: "save", blocks: [] }), /validation_error/);
  await assert.rejects(call({ action: "get", publish: true }), /validation_error/);
  await assert.rejects(
    call({ action: "save", ...save("invalid-02", 3), unexpected: true }),
    /validation_error/,
  );
  // Existing references remain usable by a different device; new foreign uploads do not.
  assert.equal((await call(save("save-0004", 3, [image]), hq, location, id(32))).version, 4);
  assert.deepEqual((await call({ action: "generate", blocks: [image] })).draft_blocks, [image]);
  console.log(
    "PASS controlled storage, raw image retention, strict SQL validation, custom-only guard",
  );
  // PGlite queues these on one connection; this verifies outcomes, not independent-session lock scheduling.
  const competitors = await Promise.allSettled([
    call(save("race-save-a", 4, [image])),
    call(save("race-save-b", 4, [image])),
  ]);
  assert.equal(competitors.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(competitors.find((r) => r.status === "rejected").reason.message, /version_conflict/);
  const replays = await Promise.all([
    call(save("race-replay", 5, [image])),
    call(save("race-replay", 5, [image])),
  ]);
  assert.deepEqual(replays[0], replays[1]);
  assert.equal(replays[0].version, 6);
  await db.exec("BEGIN");
  assert.equal((await call(save("rollback-01", 6, [], true))).version, 7);
  await db.exec("ROLLBACK");
  assert.equal((await call({ action: "get" })).version, 6);
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int n FROM inv_product_content_ops WHERE client_op_id='rollback-01'`,
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(await published(), { version: 2, published_blocks: [text, image] });
  const reordered = {
    publish: false,
    blocks: [image],
    expected_version: 5,
    client_op_id: "race-replay",
    action: "save",
  };
  assert.deepEqual(await call(reordered), replays[0]);
  await assert.rejects(
    call({ action: "save", blocks: [image], expected_version: 5, client_op_id: "race-replay" }),
    /client_op_id_conflict/,
  );
  console.log(
    "PASS queued competing saves, exact duplicate saves, rollback of content plus operation, immutable omitted/default fields",
  );
  const claim = () => db.query(`SELECT * FROM product_content_image_claim(2)`).then((r) => r.rows);
  const finish = (job, target, error = null) =>
    db
      .query(`SELECT product_content_image_finish($1,$2,$3,$4) result`, [
        job.id,
        job.claim_token,
        target,
        error,
      ])
      .then((r) => r.rows[0].result);
  const targetFor = async (job) => {
    const path = `content/${job.sku_id}/${job.id}/${job.claim_token}.png`;
    await db.exec("RESET ROLE");
    await db.query(`INSERT INTO storage.objects VALUES('sku-listing',$1)`, [path]);
    await db.exec("SET ROLE service_role");
    return `sku-listing/${path}`;
  };
  let [job] = await claim();
  assert.equal(job.source_path, image.storage_path);
  assert.equal(job.block_id, image.id);
  assert.equal((await claim()).length, 0, "Active lease cannot be claimed twice");
  assert.equal(await finish({ ...job, claim_token: id(999) }, null, "failed"), "stale");
  await call(save("caption-edit", 6, [{ ...image, caption: "Human caption" }]));
  const target = await targetFor(job);
  assert.equal(await finish(job, target), "succeeded");
  const optimized = await call({ action: "get" });
  assert.equal(optimized.version, 8);
  assert.equal(optimized.draft_blocks[0].caption, "Human caption");
  assert.equal(optimized.draft_blocks[0].storage_path, target);
  assert.deepEqual(optimized.published_blocks, [text, { ...image, storage_path: target }]);
  assert.equal((await published()).version, 8);
  assert.deepEqual(
    await call(save("save-0002", 1, [text, image], true)),
    second,
    "Async completion must not rewrite immutable operation responses",
  );
  await assert.rejects(call(save("stale-after-ai", 7, [image])), /version_conflict/);
  assert.equal(
    (await db.query(`SELECT source_path FROM inv_product_content_image_jobs`)).rows[0].source_path,
    image.storage_path,
    "Raw reference retained",
  );
  assert.equal(
    (await call(save("republish-raw", 8, [image], true), hq, location, id(32))).version,
    9,
    "Other device may restore this SKU's retained raw source",
  );
  [job] = await claim();
  await call(save("remove-block", 9, [], true));
  assert.equal(await finish(job, await targetFor(job)), "cancelled");
  assert.deepEqual((await call({ action: "get" })).published_blocks, []);
  assert.equal((await call({ action: "get" })).version, 10, "Removed blocks never resurrect");
  await call(save("restore-block", 10, [image], true));
  [job] = await claim();
  const replacement = { ...image, storage_path: `sku-raw/2026-09-27/${device}/replacement.jpg` };
  await db.exec("RESET ROLE");
  await db.query(`INSERT INTO storage.objects VALUES('sku-raw',$1)`, [
    replacement.storage_path.slice(8),
  ]);
  await db.exec("SET ROLE service_role");
  await call(save("replace-source", 11, [replacement], true));
  assert.equal(await finish(job, await targetFor(job)), "cancelled");
  assert.deepEqual((await published()).published_blocks, [replacement]);
  [job] = await claim();
  await db.query(
    `UPDATE inv_product_content_image_jobs SET lease_until=now()-interval '1 second' WHERE id=$1`,
    [job.id],
  );
  const [reclaimed] = await claim();
  assert.notEqual(reclaimed.claim_token, job.claim_token);
  assert.equal(await finish(job, await targetFor(job)), "stale");
  assert.equal(await finish(reclaimed, null, "temporary failure"), "retryable_failed");
  assert.deepEqual(
    (await published()).published_blocks,
    [replacement],
    "Preparation failure keeps raw block",
  );
  await db.query(
    `UPDATE inv_product_content_image_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1`,
    [reclaimed.id],
  );
  [job] = await claim();
  assert.equal(await finish(job, await targetFor(job)), "succeeded");
  assert.equal((await call({ action: "get" })).version, 13);
  await db.exec("BEGIN");
  await call(save("rollback-job", 13, [{ ...replacement, id: "rolled-back-block" }], true));
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int n FROM inv_product_content_image_jobs WHERE block_id='rolled-back-block'`,
      )
    ).rows[0].n,
    1,
  );
  await db.exec("ROLLBACK");
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int n FROM inv_product_content_image_jobs WHERE block_id='rolled-back-block'`,
      )
    ).rows[0].n,
    0,
  );
  await call(save("retry-budget", 13, [replacement], true));
  for (let attempt = 1; attempt <= 5; attempt++) {
    [job] = await claim();
    assert.equal(job.attempts, attempt);
    assert.equal(
      await finish(job, null, "offline"),
      attempt === 5 ? "permanent_failed" : "retryable_failed",
    );
    await db.query(
      `UPDATE inv_product_content_image_jobs SET next_run_at=now()-interval '1 second' WHERE id=$1`,
      [job.id],
    );
  }
  assert.equal((await claim()).length, 0);
  assert.deepEqual((await published()).published_blocks, [replacement]);
  await call(save("retry-manually", 14, [replacement], true));
  [job] = await claim();
  assert.equal(job.attempts, 1, "Explicit republish can retry a permanently failed raw image");
  await assert.rejects(finish(job, "sku-listing/someone-elses-image.jpg"), /validation_error/);
  await call(save("replace-block-id", 15, [{ ...replacement, id: "new-block" }], true));
  assert.equal(
    await finish(job, await targetFor(job)),
    "cancelled",
    "Same path with a different ID must not be replaced by an old job",
  );
  assert.deepEqual((await published()).published_blocks, [{ ...replacement, id: "new-block" }]);
  [job] = await claim();
  await call(save("remove-draft-only", 16, [], false));
  assert.equal(await finish(job, await targetFor(job)), "succeeded");
  assert.deepEqual(
    (await call({ action: "get" })).draft_blocks,
    [],
    "Published processing must not resurrect a removed draft block",
  );
  assert.equal((await call({ action: "get" })).version, 18);
  assert.equal((await published()).published_blocks[0].id, "new-block");
  assert.equal((await db.query(`SELECT stock_qty FROM inv_skus`)).rows[0].stock_qty, 1);
  assert.deepEqual(
    (await db.query(`SELECT image_paths FROM inv_skus`)).rows[0].image_paths,
    [],
    "Detail optimization must not modify gallery paths",
  );
  console.log(
    "PASS durable publish queue, ruler-worker handoff, raw retention, fenced leases, retries, deleted/replaced block protection and version advancement",
  );
  await db.exec(
    "RESET ROLE; UPDATE inv_skus SET image_paths=ARRAY[NULL]::text[]; SET ROLE service_role",
  );
  await assert.rejects(
    call({
      action: "generate",
      blocks: [{ ...image, storage_path: "sku-raw/private-other-store.jpg" }],
    }),
    /image_forbidden/,
    "NULL legacy image entries must not bypass path ownership",
  );
  await db.exec("RESET ROLE");
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(call({ action: "get" }), /permission denied/);
    await assert.rejects(published(), /permission denied/);
    await assert.rejects(claim(), /permission denied/);
    await assert.rejects(finish(job, null, "forged"), /permission denied/);
    for (const table of [
      "inv_product_content",
      "inv_product_content_ops",
      "inv_product_content_image_jobs",
    ]) {
      await assert.rejects(db.query(`SELECT * FROM ${table}`), /permission denied/);
      await assert.rejects(db.query(`DELETE FROM ${table}`), /permission denied/);
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(
          (
            await db.query(`SELECT has_table_privilege(current_user,$1,$2) allowed`, [
              table,
              privilege,
            ])
          ).rows[0].allowed,
          false,
        );
      }
    }
    await db.exec("RESET ROLE");
  }
  assert.equal(
    (await db.query(`SELECT notes,stock_qty FROM inv_skus`)).rows[0].notes,
    "keep summary",
  );
  assert.equal((await db.query(`SELECT qty FROM inv_stocks`)).rows[0].qty, 0);
  assert.equal(
    (await db.query(`SELECT description FROM commerce_listings`)).rows[0].description,
    "keep listing summary",
  );
  console.log("PASS private table/function grants and unchanged summary, inventory and listings");
} finally {
  await db.close();
}
