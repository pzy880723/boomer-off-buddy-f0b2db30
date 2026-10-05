import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  INBOX_STATUSES,
  ingestAssetMessage,
  processAssetInbox,
  retryDelayMs,
  LEASE_MS,
  verifyYouzanSign,
  type InboxStore,
  type InboxRow,
} from "./youzan-asset-inbox.server";

const CID = "cid";
const SECRET = "sec";
const sign = (msg: string) => createHash("md5").update(`${CID}${msg}${SECRET}`).digest("hex");
const msg = (o: unknown) => JSON.stringify(o);

/** In-memory twin of the SQL functions (unique (kdt_id,event_id), hash conflict, SKIP LOCKED claim). */
function memStore(): InboxStore & { rows: InboxRow[]; conflicts: number } {
  const rows: InboxRow[] = [];
  let tok = 0;
  const s = {
    rows,
    conflicts: 0,
    async ingest(i: { kdt_id: number; event_id: string; msg_type: string; payload_hash: string; payload: unknown }) {
      const hit = rows.find((r) => r.kdt_id === i.kdt_id && r.event_id === i.event_id);
      if (hit) {
        if (hit.payload_hash === i.payload_hash) return { result: "duplicate" as const, id: hit.id };
        s.conflicts++;
        return { result: "conflict" as const, id: hit.id };
      }
      const row: InboxRow = { id: `r${rows.length + 1}`, ...i, status: "pending", attempts: 0, next_attempt_at: 0 };
      rows.push(row);
      return { result: "accepted" as const, id: row.id };
    },
    async claim(limit: number, now: number) {
      const due = rows
        .filter((r) => r.next_attempt_at <= now && (r.status === "pending" || r.status === "retry" ||
          (r.status === "processing" && (r.lease_until ?? 0) < now)))
        .slice(0, limit);
      for (const r of due) {
        r.status = "processing"; r.attempts++; r.claim_token = `t${++tok}`; r.lease_until = now + LEASE_MS;
      }
      return due.map((r) => ({ ...r }));
    },
    async finish(id: string, token: string, status: InboxRow["status"], reason: string | null, next: number, now: number) {
      const r = rows.find((x) => x.id === id)!;
      if (r.status !== "processing" || r.claim_token !== token || (r.lease_until ?? 0) <= now) return false;
      r.status = status; r.reason = reason; r.next_attempt_at = next; r.claim_token = null; r.lease_until = null;
      return true;
    },
    async requeue(id: string) {
      const r = rows.find((x) => x.id === id)!;
      if (r.status === "blocked" || r.status === "dead" || r.status === "processing") {
        r.status = "pending"; r.claim_token = null; r.lease_until = null; r.next_attempt_at = 0;
      }
    },
  };
  return s;
}

const body = (o: Record<string, unknown>) => {
  const m = msg(o.msgObj ?? { a: 1 });
  return { id: "e1", kdt_id: 153242272, type: "T", msg: m, sign: sign(m), ...o, msgObj: undefined };
};

test("验签错误：不落库", async () => {
  const st = memStore();
  const r = await ingestAssetMessage(st, { ...body({}), sign: "bad" }, { clientId: CID, clientSecret: SECRET });
  assert.equal(r.status, 401);
  assert.equal(st.rows.length, 0);
});

test("密钥未配置：拒绝而不是放行", async () => {
  const st = memStore();
  const r = await ingestAssetMessage(st, body({}), { clientId: "", clientSecret: "" });
  assert.equal(r.status, 503);
  assert.equal(st.rows.length, 0);
});

test("verifyYouzanSign 大小写不敏感、长度不同直接 false", () => {
  const m = "x";
  assert.equal(verifyYouzanSign(m, sign(m).toUpperCase(), CID, SECRET), true);
  assert.equal(verifyYouzanSign(m, "abc", CID, SECRET), false);
});

test("缺事件身份(id/kdt_id/type)：422 不落库", async () => {
  const st = memStore();
  const r = await ingestAssetMessage(st, { ...body({}), id: "" }, { clientId: CID, clientSecret: SECRET });
  assert.equal(r.status, 422);
  assert.equal(st.rows.length, 0);
});

test("并发重复：同一事件并发 5 次只入库 1 行", async () => {
  const st = memStore();
  const rs = await Promise.all(
    Array.from({ length: 5 }, () => ingestAssetMessage(st, body({}), { clientId: CID, clientSecret: SECRET })),
  );
  assert.equal(st.rows.length, 1);
  assert.equal(rs.filter((r) => r.result === "accepted").length, 1);
  assert.equal(rs.filter((r) => r.result === "duplicate").length, 4);
  assert.ok(rs.every((r) => r.status === 200));
});

test("载荷冲突：同事件身份不同内容 409，原行不被覆盖", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({ msgObj: { a: 1 } }), { clientId: CID, clientSecret: SECRET });
  const r = await ingestAssetMessage(st, body({ msgObj: { a: 2 } }), { clientId: CID, clientSecret: SECRET });
  assert.equal(r.status, 409);
  assert.equal(r.result, "conflict");
  assert.equal(st.rows.length, 1);
  assert.deepEqual(st.rows[0].payload, { a: 1 });
});

test("未知会员：blocked unknown_member，绝不成功", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), { clientId: CID, clientSecret: SECRET });
  const out = await processAssetInbox(st, { resolveMember: async () => ({ kind: "unknown" }) }, { now: 1000 });
  assert.equal(st.rows[0].status, "blocked");
  assert.equal(st.rows[0].reason, "unknown_member");
  assert.equal(out.blocked, 1);
});

test("已知会员但资产适配未接通：blocked asset_adapter_not_connected", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), { clientId: CID, clientSecret: SECRET });
  await processAssetInbox(st, { resolveMember: async () => ({ kind: "found", customerId: "c1" }) }, { now: 1000 });
  assert.equal(st.rows[0].status, "blocked");
  assert.equal(st.rows[0].reason, "asset_adapter_not_connected");
});

test("状态集合不含任何成功/已扣账状态", () => {
  for (const s of ["done", "succeeded", "applied", "ok"]) assert.ok(!(INBOX_STATUSES as readonly string[]).includes(s));
});

test("延迟重试：暂时性错误按退避重排，到期后可重放，超限 dead", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), { clientId: CID, clientSecret: SECRET });
  const boom = { resolveMember: async () => { throw new Error("db down secret=xyz"); } };
  await processAssetInbox(st, boom, { now: 0 });
  assert.equal(st.rows[0].status, "retry");
  assert.equal(st.rows[0].next_attempt_at, retryDelayMs(1));
  assert.ok(!String(st.rows[0].reason).includes("xyz"));
  // 未到期不被认领
  assert.equal((await processAssetInbox(st, boom, { now: retryDelayMs(1) - 1 })).claimed, 0);
  // 到期重放
  assert.equal((await processAssetInbox(st, boom, { now: retryDelayMs(1) })).claimed, 1);
  for (let i = 0; i < 10; i++) await processAssetInbox(st, boom, { now: 1e12 + i * 1e8 });
  assert.equal(st.rows[0].status, "dead");
});

test("retryDelayMs 指数退避且封顶 1 小时", () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(20), 3_600_000);
});

// ---- 审查边界（0025）----
const creds = { clientId: CID, clientSecret: SECRET };

test("fencing：lease 过期被 B 认领后，A 的旧 token 不能覆盖 B 的结果", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), creds);
  const [a] = await st.claim(1, 0);
  const [b] = await st.claim(1, LEASE_MS + 1);
  assert.ok(b && b.claim_token !== a.claim_token);
  assert.equal(await st.finish(b.id, b.claim_token!, "blocked", "unknown_member", 0, LEASE_MS + 2), true);
  assert.equal(await st.finish(a.id, a.claim_token!, "retry", "transient_error", 9, LEASE_MS + 3), false);
  assert.equal(st.rows[0].status, "blocked");
});

test("过期 lease 不能 finish", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), creds);
  const [a] = await st.claim(1, 0);
  assert.equal(await st.finish(a.id, a.claim_token!, "blocked", "x", 0, LEASE_MS), false);
});

test("requeue 后旧 claim 失效", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), creds);
  const [a] = await st.claim(1, 0);
  await st.requeue(a.id);
  assert.equal(await st.finish(a.id, a.claim_token!, "blocked", "x", 0, 1), false);
  assert.equal(st.rows[0].status, "pending");
});

test("processAssetInbox 丢失 lease 时计 stale，不报错", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), creds);
  const slow = { resolveMember: async () => { await st.claim(1, LEASE_MS + 10); return { kind: "unknown" as const }; } };
  const out = await processAssetInbox(st, slow, { now: 0 });
  assert.equal(out.stale, 1);
  assert.equal(st.rows[0].status, "processing");
});

test("签名：32 个非 ASCII 字符或非 hex 不抛错，直接 false", () => {
  assert.equal(verifyYouzanSign("x", "签".repeat(32), CID, SECRET), false);
  assert.equal(verifyYouzanSign("x", "g".repeat(32), CID, SECRET), false);
  assert.equal(verifyYouzanSign("x", undefined as never, CID, SECRET), false);
});

test("reason 固定安全代码，不复制 Error.name", async () => {
  const st = memStore();
  await ingestAssetMessage(st, body({}), creds);
  const e = new Error("m"); e.name = "token=SECRET123";
  await processAssetInbox(st, { resolveMember: async () => { throw e; } }, { now: 0 });
  assert.equal(st.rows[0].reason, "transient_error");
});

test("事件身份严格标量：对象/布尔/数组被拒", async () => {
  for (const bad of [{ id: { x: 1 } }, { kdt_id: true }, { type: 5 }, { id: ["e1"] }, { kdt_id: "12a" }, { kdt_id: 1.5 }]) {
    const st = memStore();
    const r = await ingestAssetMessage(st, { ...body({}), ...bad } as never, creds);
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal(st.rows.length, 0);
  }
  const st = memStore();
  assert.equal((await ingestAssetMessage(st, { ...body({}), id: 123, kdt_id: "153242272" }, creds)).status, 200);
});
