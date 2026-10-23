import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

// Isolated PGlite: legacy POS fixture + 0032 HQ ledger + HQ redemption migration. No remote calls, no real data.
const root = new URL("../../../", import.meta.url);
const { PGlite } = await import(process.env.POINTS_PGLITE_MODULE
  ? pathToFileURL(process.env.POINTS_PGLITE_MODULE).href : "@electric-sql/pglite");
const db = new PGlite();
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const HQ = 100, SHOP = 101, OTHER_HQ = 200, OTHER_SHOP = 201;
const FP = "a".repeat(64);
const RULE = { points_per_yuan: 100, max_points: 500, fingerprint: FP, hq_kdt_id: HQ };
const SQL = process.env.POS_HQ_POINTS_SQL
  ? pathToFileURL(process.env.POS_HQ_POINTS_SQL) : new URL("drizzle/migrations/0109_pos_hq_points_redemption.sql", root);

before(async () => {
  await db.exec(await readFile(new URL("tests/sql/pos-points-fixture.sql", root), "utf8"));
  await db.exec(await readFile(new URL("supabase/migrations/20260728120000_pos_member_discount_workflows.sql", root), "utf8"));
  const legacy = await readFile(new URL("supabase/migrations/20260803142151_f090c669-5831-41ec-aa6d-cc9f4a039f02.sql", root), "utf8");
  await db.exec(legacy.slice(legacy.indexOf("CREATE OR REPLACE FUNCTION public.pos_complete_sale(")));
  await db.exec(await readFile(new URL("supabase/migrations/20261002174301_pos_points_redemption.sql", root), "utf8"));
  await db.exec(`
    CREATE TABLE public.youzan_shops (id uuid PRIMARY KEY, kdt_id bigint UNIQUE, role text, parent_kdt_id bigint, status text);
    ALTER TABLE public.inv_locations ADD COLUMN shop_id uuid;
    ALTER TABLE public.commerce_order_items ADD COLUMN IF NOT EXISTS brand_id uuid,
      ADD COLUMN IF NOT EXISTS brand_name_snapshot text, ADD COLUMN IF NOT EXISTS character_id uuid,
      ADD COLUMN IF NOT EXISTS character_name_snapshot text;
    CREATE TABLE public.pos_payment_attempts (id uuid PRIMARY KEY, location_id uuid, shift_id uuid, operator_id uuid,
      provider text, amount numeric(12,2), status text, client_op_id text UNIQUE, order_id uuid);
  `);
  await db.exec(await readFile(new URL("drizzle/migrations/0032_youzan_points_operations.sql", root), "utf8"));
  await db.exec(await readFile(SQL, "utf8"));
  await db.exec(`
    INSERT INTO youzan_shops VALUES ('${id(90)}',${HQ},'hq',NULL,'active'),('${id(91)}',${SHOP},'branch',${HQ},'active'),
      ('${id(92)}',${OTHER_HQ},'hq',NULL,'active'),('${id(93)}',${OTHER_SHOP},'branch',${OTHER_HQ},'active');
    INSERT INTO inv_locations(id,shop_id) VALUES ('${id(1)}','${id(91)}'),('${id(11)}','${id(93)}'),('${id(21)}',NULL);
    INSERT INTO commerce_customers VALUES ('${id(2)}','active'),('${id(12)}','active'),('${id(22)}','active');
    INSERT INTO pos_registers(id) VALUES ('${id(3)}');
    INSERT INTO pos_shifts(id,location_id,operator_id,register_id) VALUES
      ('${id(4)}','${id(1)}','${id(5)}','${id(3)}'),('${id(14)}','${id(11)}','${id(5)}','${id(3)}'),
      ('${id(24)}','${id(21)}','${id(5)}','${id(3)}');
    INSERT INTO inv_skus(id,price_tier) VALUES ('${id(6)}',10.01);
    INSERT INTO inv_stocks VALUES ('${id(6)}','${id(1)}',100);
    INSERT INTO pos_customer_wallets(customer_id,points) VALUES ('${id(2)}',3000);
  `);
});
after(() => db.close());

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as Record<string, any>;
const items = (q = 3) => JSON.stringify([{ sku_id: id(6), quantity: q }]);
async function freeze(op: string, o: Partial<{ shift: string; customer: string; yz: string; points: number; mode: string;
  rule: object; discount: object; q: number }> = {}) {
  const a = { shift: id(4), customer: id(2), yz: "OPEN_A", points: 100, mode: "cash", rule: RULE, discount: {}, q: 3, ...o };
  return (await one(`SELECT pos_points_intent_freeze($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb,NULL,NULL) r`,
    [a.shift, id(5), op, a.customer, a.yz, items(a.q), JSON.stringify(a.discount), a.mode, a.points, JSON.stringify(a.rule)])).r;
}
const claim = async (opId: string) => (await one("SELECT youzan_points_operation_claim($1) r", [opId])).r;
const markSent = async (opId: string, token: string) => (await one("SELECT youzan_points_operation_mark_sent($1,$2) r", [opId, token])).r;
const finish = async (opId: string, token: string, st: string, reason: string | null = null) =>
  (await one("SELECT youzan_points_operation_finish($1,$2,$3,$4) r", [opId, token, st, reason])).r;
async function remoteSucceeds(opId: string) {
  const c = await claim(opId); assert.ok(c); assert.equal(await markSent(opId, c.claim_token), true);
  assert.equal(await finish(opId, c.claim_token, "succeeded"), true);
}
const sync = async (intent: string) => (await one("SELECT pos_points_intent_sync($1) r", [intent])).r;
const v4 = async (intent: string, tenders: object[]) =>
  (await one("SELECT pos_complete_sale_v4($1,$2,$3::jsonb) r", [intent, id(5), JSON.stringify(tenders)])).r;
const wallet = async () => Number((await one(`SELECT points FROM pos_customer_wallets WHERE customer_id='${id(2)}'`)).points);
const ledgerRows = async () => Number((await one("SELECT count(*)::int n FROM commerce_points_ledger")).n);
async function resolveAll(customer = id(2)) {
  // Clear any unresolved operation of a member between tests via the real reconcile + manual absent path.
  await db.exec(`UPDATE youzan_points_operations SET status='blocked', resolution='not_sent', claim_token=NULL, lease_until=NULL
    WHERE customer_id='${customer}' AND status IN ('pending','processing','unknown')`);
}

test("ledger: unknown and sent-expired operations are never re-claimed; pre-send block frees the member", async () => {
  const f = await freeze("ledger-op-0001");
  const opId = f.debit_operation_id;
  const c = await claim(opId);
  assert.equal(await markSent(opId, c.claim_token), true);
  // Blocked after the send marker is coerced to unknown, never "not sent".
  assert.equal(await finish(opId, c.claim_token, "blocked", "proxy_timeout"), true);
  let row = await one("SELECT status, reason, resolution FROM youzan_points_operations WHERE id=$1", [opId]);
  assert.deepEqual([row.status, row.reason, row.resolution], ["unknown", "blocked_after_send", null]);
  assert.equal(await claim(opId), null, "unknown is reconcile-only");
  // Expired lease after send: still not claimable.
  await db.exec(`UPDATE youzan_points_operations SET status='processing', lease_until=now()-interval '1 minute' WHERE id='${opId}'`);
  assert.equal(await claim(opId), null);
  await assert.rejects(freeze("ledger-op-0002"), /customer_operation_in_flight/);
  await resolveAll();
  // Pre-send block: resolution not_sent, member is free for the next sale.
  const g = await freeze("ledger-op-0003");
  const c2 = await claim(g.debit_operation_id);
  assert.equal(await finish(g.debit_operation_id, c2.claim_token, "blocked", "points_write_not_enabled"), true);
  row = await one("SELECT status, resolution FROM youzan_points_operations WHERE id=$1", [g.debit_operation_id]);
  assert.deepEqual([row.status, row.resolution], ["blocked", "not_sent"]);
  assert.equal((await sync(g.intent_id)).status, "released");
  const h = await freeze("ledger-op-0004");
  assert.equal(h.status, "debit_pending");
  // Succeeded without a send marker is impossible.
  const c3 = await claim(h.debit_operation_id);
  await assert.rejects(finish(h.debit_operation_id, c3.claim_token, "succeeded"), /succeeded_without_send/);
  await resolveAll();
});

test("ledger: reconcile requires complete, unique, signed biz_value evidence; absent never auto-releases", async () => {
  const f = await freeze("recon-op-0001");
  const opId = f.debit_operation_id;
  const c = await claim(opId); await markSent(opId, c.claim_token);
  await finish(opId, c.claim_token, "unknown", "remote_result_unconfirmed");
  const sent = Number((await one("SELECT floor(extract(epoch FROM remote_sent_at))::bigint s FROM youzan_points_operations WHERE id=$1", [opId])).s);
  const ev = (o: object) => JSON.stringify({ kdt_id: HQ, biz_value: `boomer-points:${opId}`, pages_complete: true,
    window_begin: sent - 3600, window_end: sent + 60, match_count: 1, amount: -100, ...o });
  const rec = (outcome: string, o: object = {}) => one("SELECT youzan_points_operation_reconcile($1,$2,$3::jsonb) r", [opId, outcome, ev(o)]);
  await assert.rejects(rec("matched", { biz_value: "boomer-points:other" }), /reconcile_evidence_mismatch/);
  await assert.rejects(rec("matched", { kdt_id: OTHER_HQ }), /reconcile_evidence_mismatch/);
  await assert.rejects(rec("matched", { pages_complete: false }), /reconcile_evidence_incomplete/);
  await assert.rejects(rec("matched", { match_count: 2 }), /reconcile_match_invalid/);
  await assert.rejects(rec("matched", { amount: 100 }), /reconcile_match_invalid/);
  await assert.rejects(rec("matched", { window_begin: sent }), /reconcile_window_insufficient/);
  // Absent is not final within 30 minutes.
  await assert.rejects(rec("absent", { match_count: 0 }), /reconcile_absent_not_final/);
  assert.equal((await rec("inconclusive", {})).r.status, "unknown");
  assert.equal((await rec("matched")).r.status, "succeeded");
  assert.equal((await sync(f.intent_id)).status, "confirmed");

  // Absent after 30 minutes stays unknown until the explicit manual resolution.
  await db.exec(`UPDATE pos_points_intents SET status='cancel_pending' WHERE id='${f.intent_id}'`);
  await resolveAll();
  await db.exec(`UPDATE pos_points_intents SET status='released' WHERE id='${f.intent_id}'`);
  const g = await freeze("recon-op-0002");
  const c2 = await claim(g.debit_operation_id); await markSent(g.debit_operation_id, c2.claim_token);
  await finish(g.debit_operation_id, c2.claim_token, "unknown", "remote_result_unconfirmed");
  await db.exec(`UPDATE youzan_points_operations SET remote_sent_at=now()-interval '40 minutes' WHERE id='${g.debit_operation_id}'`);
  const s2 = Number((await one("SELECT floor(extract(epoch FROM remote_sent_at))::bigint s FROM youzan_points_operations WHERE id=$1", [g.debit_operation_id])).s);
  const absent = await one("SELECT youzan_points_operation_reconcile($1,'absent',$2::jsonb) r", [g.debit_operation_id,
    JSON.stringify({ kdt_id: HQ, biz_value: `boomer-points:${g.debit_operation_id}`, pages_complete: true,
      window_begin: s2 - 3600, window_end: Math.floor(Date.now() / 1000), match_count: 0 })]);
  assert.equal(absent.r.status, "unknown");
  assert.equal(await claim(g.debit_operation_id), null);
  assert.equal((await sync(g.intent_id)).status, "unknown");
  const resolved = await one("SELECT youzan_points_operation_resolve_absent($1) r", [g.debit_operation_id]);
  assert.equal(resolved.r.resolution, "remote_absent_reconciled");
  assert.equal((await sync(g.intent_id)).status, "released");
});

test("freeze: server quote, store/HQ binding, calibrated rule and normalized request are enforced", async () => {
  await assert.rejects(freeze("freeze-op-0001", { shift: id(14) }), /points_store_not_under_hq/);
  await assert.rejects(freeze("freeze-op-0002", { shift: id(24) }), /points_store_not_mapped/);
  await assert.rejects(freeze("freeze-op-0003", { rule: { ...RULE, fingerprint: "x" } }), /points_rule_not_configured/);
  await assert.rejects(freeze("freeze-op-0004", { points: 600 }), /points_balance_or_unit_invalid/);
  await assert.rejects(freeze("freeze-op-0005", { rule: { ...RULE, points_per_yuan: 3 }, points: 1 }), /points_balance_or_unit_invalid/);
  await assert.rejects(freeze("freeze-op-0006", { points: 500, q: 1, rule: { ...RULE, max_points: 5000 }, discount: { type: "amount", value: 9 } }), /points_cap_exceeded/);
  const f = await freeze("freeze-op-0007", { points: 1 });
  // 3 x 10.01 = 30.03 yuan; 1 point = 1 fen under the UI-calibrated 100 points = 1 yuan.
  assert.equal(Number(f.points_fen), 1);
  assert.equal(Number(f.payable_fen), 3002);
  const replay = await freeze("freeze-op-0007", { points: 1 });
  assert.equal(replay.intent_id, f.intent_id); assert.equal(replay.replayed, true);
  await assert.rejects(freeze("freeze-op-0007", { points: 2 }), /idempotency_conflict/);
  await assert.rejects(freeze("freeze-op-0007", { points: 1, rule: { ...RULE, fingerprint: "b".repeat(64) } }), /idempotency_conflict/);
  const op = await one("SELECT kind, points, kdt_id, source_kdt_id, operation_key, status FROM youzan_points_operations WHERE id=$1", [f.debit_operation_id]);
  assert.deepEqual([op.kind, op.points, Number(op.kdt_id), Number(op.source_kdt_id), op.status], ["debit", 1, HQ, SHOP, "pending"]);
  assert.equal(op.operation_key, `pos-intent:${f.intent_id}`);
  await resolveAll();
});

test("cash v4 settles only a confirmed HQ debit, conserves line allocation and never touches the wallet", async () => {
  const walletBefore = await wallet(); const ledgerBefore = await ledgerRows();
  const f = await freeze("cash-op-0001", { points: 101 });
  await assert.rejects(v4(f.intent_id, [{ provider: "cash", amount: 30 }]), /points_intent_not_confirmed/);
  await remoteSucceeds(f.debit_operation_id);
  assert.equal((await sync(f.intent_id)).status, "confirmed");
  await assert.rejects(v4(f.intent_id, [{ provider: "wechat", amount: 29.02, provider_transaction_id: "t" }]), /points_tender_mode_mismatch/);
  const sale = await v4(f.intent_id, [{ provider: "cash", amount: 29.02 }]);
  assert.equal(Number(sale.total_amount), 29.02);
  assert.equal(sale.points_redemption.source, "youzan_hq");
  assert.equal(sale.points_redemption.applied_points, 101);
  const alloc = await one(`SELECT sum((discount_snapshot->>'points_allocated')::int)::int s FROM commerce_order_items WHERE order_id=$1`, [sale.order_id]);
  assert.equal(alloc.s, 101);
  assert.equal(await wallet(), walletBefore); assert.equal(await ledgerRows(), ledgerBefore);
  const replay = await v4(f.intent_id, [{ provider: "cash", amount: 29.02 }]);
  assert.equal(replay.replayed, true); assert.equal(replay.order_id, sale.order_id);
  assert.equal((await one("SELECT status FROM pos_points_intents WHERE id=$1", [f.intent_id])).status, "settled");
  // Price change between freeze and settlement is rejected.
  const g = await freeze("cash-op-0002", { points: 1 });
  await remoteSucceeds(g.debit_operation_id); await sync(g.intent_id);
  await db.exec(`UPDATE inv_skus SET price_tier=11 WHERE id='${id(6)}'`);
  await assert.rejects(v4(g.intent_id, [{ provider: "cash", amount: 33 }]), /points_quote_changed/);
  await db.exec(`UPDATE inv_skus SET price_tier=10.01 WHERE id='${id(6)}'`);
  // Cash recovery cancel compensates the full debit through the 0032 ledger, then blocks late settlement.
  const cancel = await one("SELECT pos_recover_sale_cancel_v2($1,$2,$3) r", [id(4), id(5), "cash-op-0002"]);
  assert.equal(cancel.r.status, "cancelled");
  const req = await one("SELECT kind, points, status, operation_id FROM pos_points_refund_requests WHERE intent_id=$1", [g.intent_id]);
  assert.deepEqual([req.kind, req.points, req.status], ["cancel", 1, "submitted"]);
  const refundOp = await one("SELECT kind, parent_id, points FROM youzan_points_operations WHERE id=$1", [req.operation_id]);
  assert.deepEqual([refundOp.kind, refundOp.parent_id, refundOp.points], ["refund", g.debit_operation_id, 1]);
  await assert.rejects(v4(g.intent_id, [{ provider: "cash", amount: 30.02 }]), /sale_operation_cancelled/);
  await remoteSucceeds(req.operation_id);
  assert.equal((await sync(g.intent_id)).status, "cancelled");
  assert.equal(await wallet(), walletBefore);
});

test("returns queue HQ refunds proportionally, never exceed the original debit, and keep cash separate", async () => {
  const walletBefore = await wallet();
  const f = await freeze("ret-op-0001", { points: 100 });
  await remoteSucceeds(f.debit_operation_id); await sync(f.intent_id);
  const sale = await v4(f.intent_id, [{ provider: "cash", amount: 29.03 }]);
  const item = (await one("SELECT id FROM commerce_order_items WHERE order_id=$1", [sale.order_id])).id;
  const ret = async (op: string, q: number) => (await one(`SELECT pos_complete_return_v2($1,$2,$3,$4,$5::jsonb,'test',NULL) r`,
    [id(4), id(5), sale.order_id, op, JSON.stringify([{ order_item_id: item, quantity: q }])])).r;
  const r1 = await ret("ret-ret-0001", 1);
  assert.equal(r1.points_refund.points, 33); assert.equal(r1.points_refund.status, "submitted");
  assert.equal(Number(r1.refund_total), 9.67);
  // Second return while the first refund is unresolved: request queued, ledger serializes.
  const r2 = await ret("ret-ret-0002", 2);
  assert.equal(r2.points_refund.points, 67); assert.equal(r2.points_refund.status, "queued");
  const first = await one("SELECT operation_id FROM pos_points_refund_requests WHERE ref_key=$1", [r1.return_id]);
  await remoteSucceeds(first.operation_id);
  await sync(f.intent_id);
  const second = await one("SELECT status, operation_id FROM pos_points_refund_requests WHERE ref_key=$1", [r2.return_id]);
  assert.equal(second.status, "submitted");
  await remoteSucceeds(second.operation_id);
  const total = await one(`SELECT sum(points)::int s FROM youzan_points_operations WHERE parent_id=$1`, [f.debit_operation_id]);
  assert.equal(total.s, 100);
  await assert.rejects(ret("ret-ret-0003", 1), /return quantity exceeds remaining quantity|refund_exceeds_debit/);
  const replay = await ret("ret-ret-0001", 1);
  assert.equal(replay.replayed, true);
  assert.equal(await wallet(), walletBefore);
});

test("async: attempt must match frozen payable; cancel requires provider-final non-paid status", async () => {
  const f = await freeze("async-op-0001", { points: 1, mode: "async" });
  await remoteSucceeds(f.debit_operation_id); await sync(f.intent_id);
  await db.exec(`INSERT INTO pos_payment_attempts VALUES ('${id(70)}','${id(1)}','${id(4)}','${id(5)}','wechat',30.00,'pending','async-op-0001',NULL)`);
  await assert.rejects(one("SELECT pos_points_intent_attach_attempt($1,$2)", [f.intent_id, id(70)]), /points_attempt_mismatch/);
  await db.exec(`UPDATE pos_payment_attempts SET amount=30.02 WHERE id='${id(70)}'`);
  assert.equal((await one("SELECT pos_points_intent_attach_attempt($1,$2) r", [f.intent_id, id(70)])).r.payment_attempt_id, id(70));
  await assert.rejects(one("SELECT pos_recover_sale_cancel_v2($1,$2,$3)", [id(4), id(5), "async-op-0001"]), /points_intent_payment_not_final/);
  await assert.rejects(one("SELECT pos_points_intent_cancel($1,$2,false)", [f.intent_id, id(5)]), /points_intent_payment_not_final/);
  await db.exec(`UPDATE pos_payment_attempts SET status='expired' WHERE id='${id(70)}'`);
  await assert.rejects(one("SELECT pos_points_intent_cancel($1,$2,true)", [f.intent_id, id(5)]), /points_intent_payment_not_final/);
  await assert.rejects(v4(f.intent_id, [{ provider: "wechat", amount: 30.03, provider_transaction_id: "tx" }]), /points_tender_mode_mismatch/);
  // A late provider success settles; compensation can no longer run.
  const sale = await v4(f.intent_id, [{ provider: "wechat", amount: 30.02, provider_transaction_id: "tx" }]);
  assert.equal(sale.points_redemption.tender_mode, "async");
  await assert.rejects(one("SELECT pos_points_intent_cancel($1,$2,true)", [f.intent_id, id(5)]), /points_intent_settled/);

  const g = await freeze("async-op-0002", { points: 1, mode: "async" });
  await remoteSucceeds(g.debit_operation_id); await sync(g.intent_id);
  await db.exec(`INSERT INTO pos_payment_attempts VALUES ('${id(71)}','${id(1)}','${id(4)}','${id(5)}','alipay',30.02,'closed','async-op-0002',NULL)`);
  await one("SELECT pos_points_intent_attach_attempt($1,$2)", [g.intent_id, id(71)]);
  const c = await one("SELECT pos_points_intent_cancel($1,$2,true) r", [g.intent_id, id(5)]);
  assert.equal(c.r.status, "cancel_pending");
  const req = await one("SELECT points, status FROM pos_points_refund_requests WHERE intent_id=$1", [g.intent_id]);
  assert.deepEqual([req.points, req.status], [1, "submitted"]);
});

test("runtime roles cannot execute any new points RPC or read intents", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    await assert.rejects(db.query("SELECT pos_points_intent_sync($1)", [id(99)]), /permission denied/);
    await assert.rejects(db.query("SELECT pos_complete_sale_v4($1,$2,'[]')", [id(99), id(5)]), /permission denied/);
    await assert.rejects(db.query("SELECT youzan_points_operation_reconcile($1,'matched','{}')", [id(99)]), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM pos_points_intents"), /permission denied/);
    await db.exec("RESET ROLE");
  }
});
