import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

// Isolated PGlite: real live v2 body + minimal base-commit stub with the production ops semantics.
const root = new URL("../../", import.meta.url);
const { PGlite } = await import("@electric-sql/pglite");
const db = new PGlite();
const SQL = process.env.SC_CANCEL_SQL ? pathToFileURL(process.env.SC_CANCEL_SQL)
  : new URL("drizzle/migrations/0110_smart_create_cancel_marks.sql", root);
const D = "00000000-0000-0000-0000-0000000000d1", U = "00000000-0000-0000-0000-0000000000a1",
  U2 = "00000000-0000-0000-0000-0000000000a2", L = "00000000-0000-0000-0000-0000000000b1",
  L2 = "00000000-0000-0000-0000-0000000000b2";

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE inv_skus (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category text, name text, price_tier numeric,
      created_at timestamptz DEFAULT clock_timestamp(), featured_stamp text, notice_tags text[] NOT NULL DEFAULT '{}',
      CONSTRAINT inv_skus_featured_stamp_check CHECK (featured_stamp IS NULL OR featured_stamp IN ('new','rare','limited','collectible','discontinued')));
    CREATE TABLE handheld_smart_create_ops (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL,
      client_op_id text NOT NULL, user_id uuid NOT NULL, location_id uuid NOT NULL, payload_fingerprint text NOT NULL,
      sku_id uuid REFERENCES inv_skus(id), bound_epcs integer DEFAULT 0, stock_qty integer,
      status text NOT NULL DEFAULT 'committed', response_json jsonb, created_at timestamptz DEFAULT now(), completed_at timestamptz,
      CONSTRAINT handheld_smart_create_ops_status_check CHECK (status = ANY (ARRAY['committed','completed'])),
      UNIQUE (device_id, client_op_id));
    CREATE TABLE listing_readiness (sku_id uuid PRIMARY KEY, image_plan text);
    CREATE TABLE inv_listing_image_jobs (sku_id uuid, status text);
    CREATE FUNCTION listing_readiness_apply_image_plan(uuid,text,uuid,text) RETURNS void LANGUAGE sql AS
      $$ UPDATE listing_readiness SET image_plan = $2 WHERE sku_id = $1 $$;
    CREATE FUNCTION listing_readiness_append_reuse_photos(uuid,text[],text,text,uuid,text) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$;
  `);
  // Notice tag dictionary functions + CHECK exactly as in 0104.
  const marks = await readFile(new URL("drizzle/migrations/0104_notice_tag_parts_missing.sql", root), "utf8");
  await db.exec(marks.slice(0, marks.indexOf("COMMENT ON COLUMN")));
  await db.exec(`ALTER TABLE inv_skus ADD CONSTRAINT inv_skus_notice_tags_check CHECK (public.inv_notice_tags_valid(notice_tags));
    -- Base commit stub mirroring production op semantics (insert-or-wait on the unique index, replay on conflict).
    CREATE FUNCTION handheld_smart_create_commit(p_device_id uuid, p_user_id uuid, p_client_op_id text, p_fingerprint text,
      p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text, p_release_shop_id uuid)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE v_op handheld_smart_create_ops; v_op_id uuid; v_sku uuid;
    BEGIN
      INSERT INTO handheld_smart_create_ops (device_id, client_op_id, user_id, location_id, payload_fingerprint)
      VALUES (p_device_id, p_client_op_id, p_user_id, p_location_id, p_fingerprint)
      ON CONFLICT (device_id, client_op_id) DO NOTHING RETURNING id INTO v_op_id;
      IF v_op_id IS NULL THEN
        SELECT * INTO v_op FROM handheld_smart_create_ops WHERE device_id = p_device_id AND client_op_id = p_client_op_id FOR UPDATE;
        IF v_op.user_id <> p_user_id OR v_op.location_id <> p_location_id OR v_op.payload_fingerprint <> p_fingerprint THEN
          RAISE EXCEPTION 'client_op_id_conflict' USING ERRCODE = 'P0409';
        END IF;
        RETURN jsonb_build_object('op_id', v_op.id, 'replayed', true, 'op_status', v_op.status, 'sku_id', v_op.sku_id,
          'response', v_op.response_json);
      END IF;
      IF p_reuse THEN SELECT id INTO v_sku FROM inv_skus WHERE category = p_sku->>'category' AND name = p_sku->>'name'
        AND price_tier = (p_sku->>'price_tier')::numeric ORDER BY created_at LIMIT 1; END IF;
      IF v_sku IS NULL THEN
        INSERT INTO inv_skus (category, name, price_tier) VALUES (p_sku->>'category', p_sku->>'name', (p_sku->>'price_tier')::numeric)
        RETURNING id INTO v_sku;
        INSERT INTO listing_readiness VALUES (v_sku, NULL);
      END IF;
      UPDATE handheld_smart_create_ops SET sku_id = v_sku, stock_qty = 1 WHERE id = v_op_id;
      RETURN jsonb_build_object('op_id', v_op_id, 'replayed', false, 'op_status', 'committed', 'sku_id', v_sku);
    END $$;`);
  await db.exec(await readFile(new URL("tests/sql/smart_create_cancel/live_commit_v2.sql", root), "utf8"));
  await db.exec(await readFile(SQL, "utf8"));
});
after(() => db.close());

const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0] as Record<string, any>;
const sku = (name: string) => JSON.stringify({ category: "toy", name, price_tier: 59.9 });
const commit = (op: string, o: Partial<{ user: string; loc: string; fp: string; name: string; marks: unknown; reuse: boolean }> = {}) => {
  const a = { user: U, loc: L, fp: "fp-" + op, name: "item-" + op, marks: null, reuse: false, ...o };
  return one(`SELECT handheld_smart_create_commit_v3($1,$2,$3,$4,$5,$6,$7::jsonb,'{}','n',NULL,'ai','v1',$8::jsonb) r`,
    [D, a.user, op, a.fp, a.loc, a.reuse, sku(a.name), a.marks === null ? null : JSON.stringify(a.marks)]).then((r) => r.r);
};
const cancel = (op: string, o: Partial<{ user: string; loc: string; fp: string }> = {}) => {
  const a = { user: U, loc: L, fp: "fp-" + op, ...o };
  return one("SELECT handheld_smart_create_cancel($1,$2,$3,$4,$5) r", [D, a.user, op, a.fp, a.loc]).then((r) => r.r);
};
const skuCount = async (name: string) => Number((await one("SELECT count(*)::int n FROM inv_skus WHERE name=$1", [name])).n);

test("NONE: cancel persists a tombstone; a late original commit is rejected and creates no SKU", async () => {
  const c = await cancel("op-none-01");
  assert.equal(c.state, "cancelled"); assert.equal(c.replayed, false); assert.equal(c.sku_id, null);
  await assert.rejects(commit("op-none-01"), (e: any) => e.code === "P0410" && /client_op_cancelled/.test(e.message));
  assert.equal(await skuCount("item-op-none-01"), 0);
  // Cancel is idempotent and keeps the cancelled state.
  const again = await cancel("op-none-01");
  assert.deepEqual([again.state, again.replayed], ["cancelled", true]);
  // A legacy caller going straight to v2 also cannot create a SKU for a tombstoned op.
  const legacy = await one(`SELECT handheld_smart_create_commit_v2($1,$2,$3,$4,$5,false,$6::jsonb,'{}','n',NULL,'ai','v1') r`,
    [D, U, "op-none-01", "fp-op-none-01", L, sku("item-op-none-01")]);
  assert.equal(legacy.r.op_status, "cancelled"); assert.equal(legacy.r.sku_id, null);
  assert.equal(await skuCount("item-op-none-01"), 0);
});

test("race order commit-first: cancel returns the committed/completed receipt and never cancels", async () => {
  const r = await commit("op-race-01");
  const c = await cancel("op-race-01");
  assert.deepEqual([c.state, c.sku_id], ["committed", r.sku_id]);
  await db.query("UPDATE handheld_smart_create_ops SET status='completed', response_json='{\"ok\":true}' WHERE id=$1", [r.op_id]);
  const done = await cancel("op-race-01");
  assert.deepEqual([done.state, done.response], ["completed", { ok: true }]);
  // Recover by retrying the same op: replay, no second SKU.
  const replay = await commit("op-race-01");
  assert.equal(replay.replayed, true); assert.equal(replay.sku_id, r.sku_id);
  assert.equal(await skuCount("item-op-race-01"), 1);
});

test("rolled-back in-flight commit leaves NONE; cancel then wins and blocks the retried original", async () => {
  await db.exec("BEGIN");
  await commit("op-rb-01");
  await db.exec("ROLLBACK");
  assert.equal((await cancel("op-rb-01")).state, "cancelled");
  await assert.rejects(commit("op-rb-01"), /client_op_cancelled/);
  assert.equal(await skuCount("item-op-rb-01"), 0);
});

test("cross-user, cross-location and fingerprint conflicts neither cancel nor create", async () => {
  await commit("op-x-01");
  await assert.rejects(cancel("op-x-01", { user: U2 }), (e: any) => e.code === "P0409");
  await assert.rejects(cancel("op-x-01", { loc: L2 }), (e: any) => e.code === "P0409");
  await assert.rejects(cancel("op-x-01", { fp: "other" }), (e: any) => e.code === "P0409");
  assert.equal((await one("SELECT status FROM handheld_smart_create_ops WHERE client_op_id='op-x-01'")).status, "committed");
  await cancel("op-x-02");
  await assert.rejects(commit("op-x-02", { user: U2 }), (e: any) => e.code === "P0409");
  await assert.rejects(commit("op-x-02", { fp: "other" }), (e: any) => e.code === "P0409");
  assert.equal(await skuCount("item-op-x-02"), 0);
});

test("marks: saved atomically on first create, invalid marks roll back everything, replay never overwrites edits", async () => {
  const r = await commit("op-m-01", { marks: { featured_stamp: "rare", notice_tags: ["parts_missing", "flawed"] } });
  assert.equal(r.marks_applied, true);
  let row = await one("SELECT featured_stamp, notice_tags FROM inv_skus WHERE id=$1", [r.sku_id]);
  assert.deepEqual([row.featured_stamp, row.notice_tags], ["rare", ["flawed", "parts_missing"]]);
  await db.query("UPDATE inv_skus SET featured_stamp='new', notice_tags='{}' WHERE id=$1", [r.sku_id]);
  const replay = await commit("op-m-01", { marks: { featured_stamp: "rare", notice_tags: ["parts_missing", "flawed"] } });
  assert.deepEqual([replay.replayed, replay.marks_applied], [true, false]);
  row = await one("SELECT featured_stamp, notice_tags FROM inv_skus WHERE id=$1", [r.sku_id]);
  assert.deepEqual([row.featured_stamp, row.notice_tags], ["new", []]);
  for (const [op, marks] of [["op-m-02", { notice_tags: ["function_uncertain", "function_unavailable"] }],
    ["op-m-03", { featured_stamp: "bogus" }], ["op-m-04", { notice_tags: ["unknown"] }], ["op-m-05", { other: 1 }]] as const) {
    await assert.rejects(commit(op, { marks }));
    assert.equal(await skuCount("item-" + op), 0, op);
    assert.equal(Number((await one("SELECT count(*)::int n FROM handheld_smart_create_ops WHERE client_op_id=$1", [op])).n), 0, op);
  }
  // Omitted marks keep the legacy path and defaults; reused SKUs are never overwritten.
  const plain = await commit("op-m-06");
  row = await one("SELECT featured_stamp, notice_tags FROM inv_skus WHERE id=$1", [plain.sku_id]);
  assert.deepEqual([plain.marks_applied, row.featured_stamp, row.notice_tags], [false, null, []]);
  const reused = await commit("op-m-07", { name: "item-op-m-06", reuse: true, marks: { featured_stamp: "limited" } });
  assert.equal(reused.sku_id, plain.sku_id); assert.equal(reused.marks_applied, false);
  assert.equal((await one("SELECT featured_stamp FROM inv_skus WHERE id=$1", [plain.sku_id])).featured_stamp, null);
});

test("runtime roles cannot execute cancel or v3", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query("SELECT handheld_smart_create_cancel($1,$2,'op','fp',$3)", [D, U, L]), /permission denied/);
    await assert.rejects(db.query("SELECT handheld_smart_create_commit_v3($1,$2,'op','fp',$3,false,'{}','{}','n',NULL,'ai','v1',NULL)", [D, U, L]), /permission denied/);
    await db.exec("RESET ROLE");
  }
});
