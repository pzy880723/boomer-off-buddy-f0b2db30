import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);
const { PGlite } = await import("@electric-sql/pglite");
const db = new PGlite();
const SQL = process.env.POS_OP_SQL ? pathToFileURL(process.env.POS_OP_SQL)
  : new URL("drizzle/migrations/0111_pos_payment_op_recover.sql", root);
const L = "00000000-0000-0000-0000-0000000000b1", L2 = "00000000-0000-0000-0000-0000000000b2";
const S = "00000000-0000-0000-0000-0000000000c1", S2 = "00000000-0000-0000-0000-0000000000c2";
const U = "00000000-0000-0000-0000-0000000000a1", U2 = "00000000-0000-0000-0000-0000000000a2";
const FP = "a".repeat(64), FP2 = "b".repeat(64);

before(async () => {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE pos_payment_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
      shift_id uuid NOT NULL, operator_id uuid NOT NULL, payment_profile_id uuid, settlement_subject_id uuid,
      provider text NOT NULL, mode text NOT NULL, out_trade_no text NOT NULL UNIQUE, amount numeric NOT NULL CHECK (amount > 0),
      currency text NOT NULL, status text NOT NULL, auth_code_hash text, auth_code_last4 text, expires_at timestamptz,
      client_op_id text NOT NULL UNIQUE, customer_id uuid, sale_payload jsonb NOT NULL, provider_response jsonb NOT NULL);`);
  await db.exec(await readFile(SQL, "utf8"));
});

const reserve = async (over: Record<string, unknown> = {}) => {
  const p = { client_op_id: "op-0000001", location_id: L, shift_id: S, operator_id: U, provider: "wechat",
    mode: "merchant_scan", out_trade_no: `T${Math.random()}`, amount: 12.5, request_fingerprint: FP,
    auth_code_hash: "h".repeat(64), auth_code_last4: "1234", sale_payload: { items: [] }, ...over };
  const r = await db.query<{ r: { state: string; id?: string } }>("select pos_payment_attempt_reserve($1::jsonb) r", [JSON.stringify(p)]);
  return r.rows[0].r;
};
const recover = async (op: string, s = S, u = U, l = L, cancel = false) =>
  (await db.query<{ r: { state: string; id?: string } }>("select pos_payment_op_recover($1,$2,$3,$4,$5) r", [op, s, u, l, cancel])).rows[0].r;

test("same op + same fingerprint replays the original attempt; no second row", async () => {
  const a = await reserve();
  const b = await reserve({ out_trade_no: "other" });
  assert.equal(a.state, "created");
  assert.deepEqual(b, { state: "existing", id: a.id });
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from pos_payment_attempts")).rows[0].n, 1);
});

test("different payload / shift / actor / store on the same op is a conflict", async () => {
  for (const over of [{ request_fingerprint: FP2 }, { shift_id: S2 }, { operator_id: U2 }, { location_id: L2 }, { provider: "alipay" }]) {
    await assert.rejects(reserve(over), /client_op_id_conflict/);
  }
});

test("recover finds the attempt only for the original shift/actor/store and never cancels it", async () => {
  const id = (await reserve()).id;
  assert.deepEqual(await recover("op-0000001", S, U, L, true), { state: "attempt", id });
  await assert.rejects(recover("op-0000001", S2), /client_op_id_conflict/);
  await assert.rejects(recover("op-0000001", S, U2), /client_op_id_conflict/);
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from pos_payment_op_tombstones")).rows[0].n, 0);
});

test("absent op: none without cancel; cancel writes a tombstone and a late create is refused", async () => {
  assert.deepEqual(await recover("op-late-001"), { state: "none" });
  assert.deepEqual(await recover("op-late-001", S, U, L, true), { state: "cancelled" });
  assert.deepEqual(await recover("op-late-001", S, U, L, true), { state: "cancelled" });
  await assert.rejects(recover("op-late-001", S, U2, L, true), /client_op_id_conflict/);
  assert.deepEqual(await reserve({ client_op_id: "op-late-001" }), { state: "cancelled" });
  assert.equal((await db.query<{ n: number }>("select count(*)::int n from pos_payment_attempts where client_op_id='op-late-001'")).rows[0].n, 0);
});

test("only service_role may execute; anon/authenticated cannot touch tombstones", async () => {
  const r = await db.query<{ role: string; ok: boolean }>(`select r as role,
    has_function_privilege(r, 'pos_payment_attempt_reserve(jsonb)', 'execute')
    and has_function_privilege(r, 'pos_payment_op_recover(text,uuid,uuid,uuid,boolean)', 'execute') as ok
    from unnest(array['anon','authenticated','service_role']) r`);
  assert.deepEqual(Object.fromEntries(r.rows.map((x) => [x.role, x.ok])), { anon: false, authenticated: false, service_role: true });
  const t = await db.query<{ ok: boolean }>("select has_table_privilege('anon','pos_payment_op_tombstones','select') ok");
  assert.equal(t.rows[0].ok, false);
});
