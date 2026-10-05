// 客服 M1 迁移行为测试（PGlite 隔离库，合成数据，不连生产）。
//   node --test scripts/check-support-assignment-sql.test.mjs
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.env.SUPPORT_PGLITE_MODULE
  ? pathToFileURL(process.env.SUPPORT_PGLITE_MODULE).href : '@electric-sql/pglite');

const L1 = '00000000-0000-0000-0000-0000000000a1';
const L2 = '00000000-0000-0000-0000-0000000000a2';
const HQ = '00000000-0000-0000-0000-0000000000b1';
const S1 = '00000000-0000-0000-0000-0000000000b2'; // 门店1员工
const S1B = '00000000-0000-0000-0000-0000000000b3'; // 门店1员工2
const S2 = '00000000-0000-0000-0000-0000000000b4'; // 门店2员工
const CUST = '00000000-0000-0000-0000-0000000000c1';
const CONV = '00000000-0000-0000-0000-0000000000d1';
const db = new PGlite();

async function migrationSql(suffix, envKey) {
  if (process.env[envKey]) return readFile(process.env[envKey], 'utf8');
  const dir = new URL('../drizzle/migrations/', import.meta.url);
  const file = (await readdir(dir)).find((f) => f.endsWith(suffix));
  return readFile(new URL(file, dir), 'utf8');
}

before(async () => {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE TYPE public.app_role AS ENUM ('super_admin','hq_operator','store_manager','store_staff','warehouse_staff');
    CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, role public.app_role);
    CREATE TABLE public.user_location_perms (user_id uuid, location_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.support_agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, scope text NOT NULL DEFAULT 'location', location_id uuid, display_name text, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.support_conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, location_id uuid, customer_id uuid, order_id uuid,
      topic text NOT NULL DEFAULT 'general', status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','closed')),
      last_message_at timestamptz, last_message_preview text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), context_key text, context jsonb);
    CREATE TABLE public.support_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES public.support_conversations(id),
      sender_type text NOT NULL, sender_user_id uuid, sender_customer_id uuid, sender_name text NOT NULL, body text NOT NULL,
      internal boolean NOT NULL DEFAULT false, client_op_id text, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT support_messages_internal_staff_only CHECK (internal = false OR sender_type = 'staff'));
    CREATE UNIQUE INDEX uq_support_messages_client_op ON public.support_messages (conversation_id, client_op_id) WHERE client_op_id IS NOT NULL;
    CREATE TABLE public.support_participants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL, user_id uuid NOT NULL,
      participant_role text NOT NULL DEFAULT 'store_staff', display_name text, joined_at timestamptz NOT NULL DEFAULT now(), last_read_at timestamptz, UNIQUE (conversation_id, user_id));
    INSERT INTO public.user_roles (user_id, role) VALUES ('${HQ}','hq_operator'),('${S1}','store_staff'),('${S2}','store_staff');
    INSERT INTO public.user_location_perms (user_id, location_id) VALUES ('${S1}','${L1}'),('${S2}','${L2}');
    INSERT INTO public.support_agents (user_id, scope, location_id) VALUES ('${S1B}','location','${L1}');
  `);
  await db.exec(await migrationSql('_support_assignment_m1.sql', 'SUPPORT_M1_SQL'));
  await db.exec(await migrationSql('_support_m1_hardening.sql', 'SUPPORT_M1B_SQL'));
});
beforeEach(() => db.exec(`RESET ROLE; DELETE FROM support_messages; DELETE FROM support_participants; DELETE FROM support_conversations;
  INSERT INTO support_conversations (id, location_id, customer_id) VALUES ('${CONV}','${L1}','${CUST}');`));
after(() => db.close());

const assign = async (actor, action, version) =>
  (await db.query('SELECT public.support_update_assignment($1,$2,$3,$4) r', [CONV, actor, action, version])).rows[0].r;
const post = async (actor, body, internal, op, version) =>
  (await db.query('SELECT public.support_staff_post_message($1,$2,$3,$4,$5,$6,$7,$8) r',
    [CONV, actor, 'n', 'store_staff', body, internal, op, version])).rows[0].r;
const conv = async () => (await db.query('SELECT * FROM support_conversations WHERE id=$1', [CONV])).rows[0];
const customerSays = (body) => db.query(`INSERT INTO support_messages (conversation_id, sender_type, sender_customer_id, sender_name, body) VALUES ($1,'customer',$2,'c',$3)`, [CONV, CUST, body]);

test('defaults keep old rows compatible', async () => {
  const c = await conv();
  assert.equal(c.channel, 'native'); assert.equal(c.assignment_version, 0); assert.equal(c.primary_agent_id, null);
});

test('claim requires location scope and exact version; second claim conflicts', async () => {
  assert.equal((await assign(S2, 'claim', 0)).code, 'forbidden');
  assert.equal((await assign(S1, 'claim', null)).code, 'assignment_version_required');
  assert.equal((await assign(S1, 'claim', 5)).code, 'version_conflict');
  const r = await assign(S1, 'claim', 0);
  assert.equal(r.ok, true); assert.equal(r.assignment_version, 1);
  assert.equal((await assign(S1B, 'claim', 0)).code, 'version_conflict');
  assert.equal((await assign(S1B, 'claim', 1)).code, 'already_claimed');
  assert.equal((await assign(S1, 'claim', 1)).code, 'already_primary');
});

test('takeover is HQ only and bumps version; old owner then cannot send but can note', async () => {
  await assign(S1, 'claim', 0);
  assert.equal((await assign(S1B, 'takeover', 1)).code, 'hq_only');
  assert.equal((await assign(S2, 'takeover', 1)).code, 'forbidden');
  const t = await assign(HQ, 'takeover', 1);
  assert.equal(t.ok, true); assert.equal(t.assignment_version, 2); assert.equal(t.primary_agent_id, HQ);
  assert.equal((await post(S1, 'hi', false, 'op1', 1)).code, 'version_conflict');
  assert.equal((await post(S1, 'hi', false, 'op2', 2)).code, 'not_primary_agent');
  const note = await post(S1, '内部备注', true, 'op3', null);
  assert.equal(note.ok, true); assert.equal(note.message.internal, true);
  assert.equal((await post(HQ, '您好', false, 'op4', 2)).ok, true);
});

test('external send needs claim; collaborators from other stores are rejected; idempotent replay', async () => {
  assert.equal((await post(S1, 'x', false, 'a', 0)).code, 'claim_required');
  assert.equal((await post(S2, 'x', true, 'b', null)).code, 'forbidden');
  await assign(S1, 'claim', 0);
  const first = await post(S1, 'x', false, 'same', 1);
  const again = await post(S1, 'x', false, 'same', 1);
  assert.equal(again.replayed, true); assert.equal(again.message.id, first.message.id);
  assert.equal((await post(S1B, 'x', true, 'same', null)).code, 'client_op_id_conflict');
  assert.equal(first.message.delivery_status, 'sent');
});

test('wechat_kf external reply rejected (channel_not_connected), internal note allowed, nothing pending', async () => {
  await db.query(`UPDATE support_conversations SET channel='wechat_kf' WHERE id=$1`, [CONV]);
  await assign(S1, 'claim', 0);
  assert.equal((await post(S1, 'x', false, 'w', 1)).code, 'channel_not_connected');
  assert.equal((await post(S1, '备注', true, 'w2', null)).ok, true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM support_messages WHERE delivery_status <> 'sent'`)).rows[0].n, 0);
});

test('close/reopen only by primary agent or HQ; unclaimed only HQ', async () => {
  assert.equal((await assign(S1, 'close', 0)).code, 'primary_or_hq_only');
  await assign(S1, 'claim', 0);
  assert.equal((await assign(S1B, 'close', 1)).code, 'primary_or_hq_only');
  assert.equal((await assign(HQ, 'close', 1)).status, 'closed');
  assert.equal((await assign(S1B, 'reopen', 2)).code, 'primary_or_hq_only');
  assert.equal((await assign(S1, 'reopen', 2)).status, 'open');
});

test('replay with same op but different body/internal conflicts; no duplicate outbound', async () => {
  await assign(S1, 'claim', 0);
  await post(S1, 'A', false, 'op', 1);
  assert.equal((await post(S1, 'B', false, 'op', 1)).code, 'client_op_id_conflict');
  assert.equal((await post(S1, 'A', true, 'op', 1)).code, 'client_op_id_conflict');
  assert.equal((await post(S1, 'A', false, 'op', 1)).replayed, true);
  assert.equal((await db.query(`SELECT count(*)::int n FROM support_messages`)).rows[0].n, 1);
});

const cpost = async (body, op, cust = CUST) =>
  (await db.query('SELECT public.support_customer_post_message($1,$2,$3,$4,$5) r', [CONV, cust, 'c', body, op])).rows[0].r;

test('customer post: ownership, closed rejects insert, op payload conflict', async () => {
  assert.equal((await cpost('hi', 'k1', S2)).code, 'not_found');
  assert.equal((await cpost('hi', 'k1')).ok, true);
  assert.equal((await cpost('changed', 'k1')).code, 'client_op_id_conflict');
  await assign(HQ, 'close', 0);
  assert.equal((await cpost('after close', 'k2')).code, 'conversation_closed');
  assert.equal((await db.query(`SELECT count(*)::int n FROM support_messages`)).rows[0].n, 1);
});

test('preview: internal notes never leak, older created_at never overwrites newer', async () => {
  await assign(S1, 'claim', 0);
  await post(S1, '公开回复', false, 'p1', 1);
  await post(S1, '内部机密', true, 'p2', null);
  let c = await conv();
  assert.equal(c.last_message_preview, '公开回复');
  const latest = c.last_message_at;
  await db.query(`INSERT INTO support_messages (conversation_id, sender_type, sender_customer_id, sender_name, body, created_at)
    VALUES ($1,'customer',$2,'c','旧消息', now() - interval '1 hour')`, [CONV, CUST]);
  c = await conv();
  assert.equal(c.last_message_preview, '公开回复');
  assert.equal(c.last_message_at.getTime(), latest.getTime());
});

test('close blocks sending, reopen restores; both versioned', async () => {
  await assign(S1, 'claim', 0);
  assert.equal((await assign(S1, 'close', 0)).code, 'version_conflict');
  assert.equal((await assign(S1B, 'close', 1)).code, 'primary_or_hq_only');
  assert.equal((await assign(S1, 'close', 1)).status, 'closed');
  assert.equal((await post(S1, 'x', false, 'c', 2)).code, 'conversation_closed');
  assert.equal((await assign(S1, 'claim', 2)).code, 'conversation_closed');
  assert.equal((await assign(S2, 'reopen', 2)).code, 'forbidden');
  assert.equal((await assign(S1B, 'reopen', 2)).code, 'primary_or_hq_only');
  const r = await assign(S1, 'reopen', 2);
  assert.equal(r.status, 'open'); assert.equal(r.assignment_version, 3);
});

test('waiting_since starts at first customer message and is not reset by follow-ups; primary reply clears', async () => {
  await customerSays('1');
  const w1 = (await conv()).waiting_since; assert.ok(w1);
  await customerSays('2');
  assert.equal((await conv()).waiting_since.getTime(), w1.getTime());
  await assign(S1, 'claim', 0);
  await post(S1B, '备注', true, 'n1', null);
  assert.ok((await conv()).waiting_since, 'internal note is not an effective reply');
  await post(S1, '回复', false, 'r1', 1);
  assert.equal((await conv()).waiting_since, null);
});

test('escalation is idempotent and uses DB time thresholds', async () => {
  await customerSays('1');
  let r = (await db.query('SELECT public.support_escalate_overdue(60,180) r')).rows[0].r;
  assert.equal(r.escalated, 0);
  await db.query(`UPDATE support_conversations SET waiting_since = now() - interval '61 seconds'`);
  r = (await db.query('SELECT public.support_escalate_overdue(60,180) r')).rows[0].r;
  assert.equal(r.escalated, 1); assert.equal((await conv()).escalation_reason, 'unclaimed_timeout');
  r = (await db.query('SELECT public.support_escalate_overdue(60,180) r')).rows[0].r;
  assert.equal(r.escalated, 0, 'second run does nothing');
  // 领取后回复清掉升级；再次等待 100 秒未达 180 秒不升级
  await assign(S1, 'claim', 0); await post(S1, '回复', false, 'r', 1);
  await customerSays('again');
  await db.query(`UPDATE support_conversations SET waiting_since = now() - interval '100 seconds'`);
  assert.equal((await db.query('SELECT public.support_escalate_overdue(60,180) r')).rows[0].r.escalated, 0);
  await db.query(`UPDATE support_conversations SET waiting_since = now() - interval '181 seconds'`);
  assert.equal((await db.query('SELECT public.support_escalate_overdue(60,180) r')).rows[0].r.escalated, 1);
  assert.equal((await conv()).escalation_reason, 'reply_timeout');
});

test('anon and authenticated cannot execute RPCs', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query('SELECT public.support_escalate_overdue(60,180)'), /permission denied/);
    await assert.rejects(db.query('SELECT public.support_update_assignment($1,$2,$3,$4)', [CONV, HQ, 'claim', 0]), /permission denied/);
    await db.exec('RESET ROLE');
  }
});
