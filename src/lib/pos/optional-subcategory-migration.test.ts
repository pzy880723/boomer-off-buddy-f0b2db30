import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, migrations), "utf8");
const migration = read("20261003140000_pos_optional_subcategory_completion.sql");
const db = new PGlite();
const roots = [
  "porcelain_jp",
  "porcelain_eu",
  "porcelain_cartoon",
  "toy_model",
  "character_ip_goods",
  "audio_media",
  "digital_appliance",
  "game_device",
  "home_goods",
  "stationery_publication",
  "fashion_wearable",
  "fashion_jewelry",
  "art_collectible",
  "daily_misc",
];
const additions = [
  ["porcelain_cartoon_drinkware", "杯具", "porcelain_cartoon"],
  ["porcelain_cartoon_plate", "盘碟", "porcelain_cartoon"],
  ["porcelain_cartoon_bowl", "碗钵", "porcelain_cartoon"],
  ["porcelain_cartoon_teaware", "壶/茶具", "porcelain_cartoon"],
  ["porcelain_cartoon_storage", "储物罐", "porcelain_cartoon"],
  ["porcelain_cartoon_vase_ornament", "花器/摆件", "porcelain_cartoon"],
  ["porcelain_cartoon_set", "套装/礼盒", "porcelain_cartoon"],
  ["game_disc", "游戏光盘", "game_device"],
];
const snapshot = async () =>
  (await db.query<Record<string, unknown>>("SELECT * FROM inv_categories ORDER BY code")).rows;

before(async () => {
  // Run the real category DDL and seed sections, without their unrelated stock/sales SQL.
  const ddl = read("20260701183547_261b6e4b-78f0-4cf0-9b1b-fac566eef9f4.sql");
  const seed = read("20260803142151_f090c669-5831-41ec-aa6d-cc9f4a039f02.sql");
  const kind = read("20260803143941_1c1cdd92-2ea0-434c-8aa9-12ba88463131.sql");
  const cartoon = read("20260826153000_cartoon_porcelain_standard_catalog.sql");
  await db.exec("CREATE TABLE public.youzan_shops(id uuid PRIMARY KEY)");
  await db.exec(ddl.slice(0, ddl.indexOf("CREATE INDEX")));
  await db.exec(read("20260702020720_9b043015-c7cf-4a52-9219-4c447f5c82e2.sql"));
  await db.exec(`BEGIN;
    ${seed.slice(0, seed.indexOf("CREATE TEMP TABLE tmp_standard_groups"))}
    ${kind.slice(0, kind.indexOf("-- 2)"))}
    ${cartoon.slice(0, cartoon.indexOf("DO $$"))}
    COMMIT;`);
});
beforeEach(() => db.exec("BEGIN"));
afterEach(() => db.exec("ROLLBACK"));
after(() => db.close());

test("all 14 existing roots have optional tags with only eight new leaf categories", async () => {
  const original = await snapshot();
  await db.exec(migration);
  const coverage = (
    await db.query<{ code: string; n: number }>(
      `
    SELECT p.code, count(c.id)::int AS n FROM inv_categories p
    LEFT JOIN inv_categories c ON c.parent_id=p.id AND c.is_active AND c.kind='category'
    WHERE p.code=ANY($1::text[]) AND p.parent_id IS NULL AND p.is_active AND p.kind='category'
    GROUP BY p.code ORDER BY p.code`,
      [roots],
    )
  ).rows;
  assert.deepEqual(
    coverage.map((row) => row.code),
    [...roots].sort(),
  );
  assert.ok(
    coverage.every((row) => row.n > 0),
    "Every root must offer a tag",
  );
  assert.equal(coverage.find((row) => row.code === "porcelain_cartoon")?.n, 7);
  const added = (
    await db.query<{ code: string; name: string; parent: string }>(
      `
    SELECT c.code,c.name,p.code AS parent FROM inv_categories c
    JOIN inv_categories p ON p.id=c.parent_id
    WHERE NOT(c.code=ANY($1::text[])) ORDER BY c.code`,
      [original.map((row) => row.code)],
    )
  ).rows;
  assert.deepEqual(
    added.map((row) => [row.code, row.name, row.parent]),
    [...additions].sort((a, b) => a[0].localeCompare(b[0])),
  );
  assert.equal((await snapshot()).length, original.length + 8);
});

test("every existing category and unrelated custom or disabled category remains byte-for-byte equivalent", async () => {
  await db.exec(`INSERT INTO inv_categories(code,name,sort_order,is_active,is_system,kind)
    VALUES ('custom_local','Local category',777,true,false,'category'),
      ('legacy_disabled','Disabled category',888,false,true,'category')`);
  const original = await snapshot();
  await db.exec(migration);
  const originalCodes = new Set(original.map((row) => row.code));
  assert.deepEqual(
    (await snapshot()).filter((row) => originalCodes.has(row.code)),
    original,
  );
});

test("system-marked business roots remain valid and unchanged while reserved roots are outside the whitelist", async () => {
  const systemRoots = [
    "toy_model",
    "character_ip_goods",
    "audio_media",
    "digital_appliance",
    "stationery_publication",
    "fashion_wearable",
    "fashion_jewelry",
    "art_collectible",
    "daily_misc",
  ];
  await db.query("UPDATE inv_categories SET is_system=true WHERE code=ANY($1::text[])", [
    systemRoots,
  ]);
  await db.exec(`INSERT INTO inv_categories(code,name,is_active,is_system,kind)
    VALUES ('classification_pending','Pending classification',true,true,'category')`);
  const original = await snapshot();
  assert.equal(
    original.filter((row) => systemRoots.includes(String(row.code)) && row.is_system === true)
      .length,
    9,
  );
  await db.exec(migration);
  const originalCodes = new Set(original.map((row) => row.code));
  assert.deepEqual(
    (await snapshot()).filter((row) => originalCodes.has(row.code)),
    original,
  );
  const first = await snapshot();
  await db.exec(migration);
  assert.deepEqual(await snapshot(), first);
});

test("system-marked existing business labels satisfy coverage without changing their values", async () => {
  await db.exec("UPDATE inv_categories SET is_system=true WHERE parent_id IS NOT NULL");
  const original = await snapshot();
  await db.exec(migration);
  const originalCodes = new Set(original.map((row) => row.code));
  assert.deepEqual(
    (await snapshot()).filter((row) => originalCodes.has(row.code)),
    original,
  );
});

test("reapplying the migration preserves all IDs, timestamps and values", async () => {
  await db.exec(migration);
  const first = await snapshot();
  await db.exec(migration);
  assert.deepEqual(await snapshot(), first);
});

test("an existing target code with the correct parent keeps its customized fields and disabled status", async () => {
  await db.exec(`INSERT INTO inv_categories(code,name,parent_id,sort_order,is_active,is_system,kind)
    SELECT 'game_disc','Existing label',id,987,false,true,'category'
    FROM inv_categories WHERE code='game_device'`);
  const original = (await snapshot()).find((row) => row.code === "game_disc");
  await db.exec(migration);
  assert.deepEqual(
    (await snapshot()).find((row) => row.code === "game_disc"),
    original,
  );
});

async function rejectsWithoutChanges(pattern: RegExp) {
  const original = await snapshot();
  await db.exec("SAVEPOINT migration_case");
  await assert.rejects(db.exec(migration), pattern);
  await db.exec("ROLLBACK TO SAVEPOINT migration_case");
  assert.deepEqual(await snapshot(), original);
}

test("a late conflicting parent fails atomically instead of reparenting or keeping earlier inserts", async () => {
  await db.exec(`INSERT INTO inv_categories(code,name,parent_id,kind)
    SELECT 'game_disc','Other parent label',id,'category' FROM inv_categories WHERE code='audio_media'`);
  await rejectsWithoutChanges(/subcategory_parent_conflict.*game_disc/);
});

test("a target code already used as a root is a parent conflict", async () => {
  await db.exec(
    "INSERT INTO inv_categories(code,name,kind) VALUES ('porcelain_cartoon_plate','Existing root','category')",
  );
  await rejectsWithoutChanges(/subcategory_parent_conflict.*porcelain_cartoon_plate/);
});

test("a missing required parent fails without silently skipping its labels", async () => {
  await db.exec("DELETE FROM inv_categories WHERE code='porcelain_cartoon'");
  await rejectsWithoutChanges(/subcategory_root_unavailable.*porcelain_cartoon/);
});

test("an inactive required parent fails without reactivating it", async () => {
  await db.exec("UPDATE inv_categories SET is_active=false WHERE code='porcelain_cartoon'");
  await rejectsWithoutChanges(/subcategory_root_unavailable.*porcelain_cartoon/);
});

test("a required root already attached to another parent is not silently promoted", async () => {
  await db.exec(`UPDATE inv_categories SET parent_id=(SELECT id FROM inv_categories WHERE code='game_device')
    WHERE code='porcelain_cartoon'`);
  await rejectsWithoutChanges(/subcategory_root_unavailable.*porcelain_cartoon/);
});

test("a legacy root without active labels fails the final coverage check without changing disabled data", async () => {
  await db.exec(`UPDATE inv_categories SET is_active=false
    WHERE parent_id=(SELECT id FROM inv_categories WHERE code='porcelain_jp')`);
  await rejectsWithoutChanges(/subcategory_root_without_labels.*porcelain_jp/);
});
