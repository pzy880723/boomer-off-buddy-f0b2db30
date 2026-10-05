import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handlePointsMessage, type PointsIngest } from "./youzan-points-message.server";

const CID = "98835eddeb9be63a79";
const SECRET = "sec";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const creds = { clientId: CID, clientSecret: SECRET };

const baseMsg = (o: Record<string, unknown> = {}) => ({
  amount: "20",
  client_hash: "",
  unique_id: "u-1",
  create_time: "2026-10-05 12:00:00",
  mobile: "13712345678",
  yz_open_id: "yzopen-1",
  total: "132",
  event_type: "4",
  ...o,
});

/** Body as Youzan sends it: msg is UrlEncode(UTF-8) of the JSON; sign over the DECODED msg. */
function envelope(msgObj: Record<string, unknown>, o: Record<string, unknown> = {}) {
  const raw = JSON.stringify(msgObj);
  return {
    client_id: CID,
    id: "yuser_123",
    kdt_id: "153242272",
    kdt_name: "总部",
    type: "POINTS",
    version: "123473843823209",
    sendCount: 0,
    msg: encodeURIComponent(raw),
    sign: md5(`${CID}${raw}${SECRET}`),
    ...o,
  };
}

function memStore() {
  const rows: Array<PointsIngest & { id: string }> = [];
  return {
    rows,
    fail: false,
    async ingest(i: PointsIngest) {
      if (this.fail) throw new Error("db down password=xyz");
      const hit = rows.find((r) => r.kdt_id === i.kdt_id && r.event_id === i.event_id);
      if (hit) return { result: hit.payload_hash === i.payload_hash ? ("duplicate" as const) : ("conflict" as const), id: hit.id };
      const row = { ...i, id: `r${rows.length + 1}` };
      rows.push(row);
      return { result: "accepted" as const, id: row.id };
    },
  };
}

const deps = (store = memStore(), active = true) => ({ store, creds, isActiveShop: async () => active });

test("签名按解码后的 msg 计算：通过并 ack code=0", async () => {
  const d = deps();
  const r = await handlePointsMessage({ body: envelope(baseMsg()) }, d);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { code: 0, msg: "success" });
  assert.equal(d.store.rows.length, 1);
});

test("签名按编码原文计算（非官方方案）被拒，不做多方案宽松", async () => {
  const d = deps();
  const raw = JSON.stringify(baseMsg({ description: "运营 活动+积分" }));
  const enc = encodeURIComponent(raw);
  const r = await handlePointsMessage({ body: envelope(baseMsg(), { msg: enc, sign: md5(`${CID}${enc}${SECRET}`) }) }, d);
  assert.equal(r.status, 401);
  assert.equal(d.store.rows.length, 0);
});

test("body 无 sign 时可用 Event-Sign 头（同一算法）", async () => {
  const d = deps();
  const e = envelope(baseMsg());
  const sign = e.sign;
  const r = await handlePointsMessage({ body: { ...e, sign: undefined }, headerSign: sign }, d);
  assert.equal(r.status, 200);
});

test("密钥未配置 503；client_id 不一致 401；均不落库", async () => {
  const d1 = deps();
  assert.equal((await handlePointsMessage({ body: envelope(baseMsg()) }, { ...d1, creds: { clientId: "", clientSecret: "" } })).status, 503);
  const d2 = deps();
  assert.equal((await handlePointsMessage({ body: envelope(baseMsg(), { client_id: "other" }) }, d2)).status, 401);
  assert.equal(d1.store.rows.length + d2.store.rows.length, 0);
});

test("msg 编码损坏 400；缺 unique_id 422；非 POINTS 422", async () => {
  const d = deps();
  assert.equal((await handlePointsMessage({ body: envelope(baseMsg(), { msg: "%E0%A4%A" }) }, d)).status, 400);
  assert.equal((await handlePointsMessage({ body: envelope(baseMsg({ unique_id: "" })) }, d)).status, 422);
  assert.equal((await handlePointsMessage({ body: envelope(baseMsg(), { type: "TRADE_TradePaid" }) }, d)).status, 422);
  assert.equal(d.store.rows.length, 0);
});

test("同一客户（同外层 id）不同 unique_id：都接收，不当冲突", async () => {
  const d = deps();
  const a = await handlePointsMessage({ body: envelope(baseMsg({ unique_id: "u-1", amount: "10" })) }, d);
  const b = await handlePointsMessage({ body: envelope(baseMsg({ unique_id: "u-2", amount: "-5" }), { version: "123473843823210" }) }, d);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(d.store.rows.length, 2);
  assert.deepEqual(d.store.rows.map((r) => r.event_id), ["u-1", "u-2"]);
});

test("同 unique_id 不同内容：409 冲突，不 ack", async () => {
  const d = deps();
  await handlePointsMessage({ body: envelope(baseMsg({ amount: "10" })) }, d);
  const r = await handlePointsMessage({ body: envelope(baseMsg({ amount: "99" })) }, d);
  assert.equal(r.status, 409);
  assert.notEqual((r.body as { code: number }).code, 0);
  assert.equal(d.store.rows.length, 1);
});

test("sendCount 重推是同一事件：duplicate 并 ack", async () => {
  const d = deps();
  await handlePointsMessage({ body: envelope(baseMsg(), { sendCount: 0 }) }, d);
  const r = await handlePointsMessage({ body: envelope(baseMsg(), { sendCount: 3 }) }, d);
  assert.equal(r.status, 200);
  assert.equal(r.result, "duplicate");
  assert.equal(d.store.rows.length, 1);
});

test("envelope 保留外层 id/version/sendCount，payload 保留 unique_id，手机号脱敏", async () => {
  const d = deps();
  await handlePointsMessage({ body: envelope(baseMsg(), { sendCount: 2 }) }, d);
  const row = d.store.rows[0];
  assert.equal(row.biz_id, "yuser_123");
  assert.equal(row.msg_version, "123473843823209");
  assert.equal((row.envelope as Record<string, unknown>).send_count, 2);
  assert.equal((row.payload as Record<string, unknown>).unique_id, "u-1");
  assert.equal((row.payload as Record<string, unknown>).mobile, "137****5678");
  assert.ok(!JSON.stringify(row).includes("13712345678"));
});

test("非授权/非 active 店铺：落库 blocked shop_not_authorized", async () => {
  const d = deps(memStore(), false);
  const r = await handlePointsMessage({ body: envelope(baseMsg()) }, d);
  assert.equal(r.status, 200);
  assert.equal(d.store.rows[0].initial_status, "blocked");
  assert.equal(d.store.rows[0].initial_reason, "shop_not_authorized");
});

test("身份不明（无 yz_open_id）：blocked missing_member_identity", async () => {
  const d = deps();
  await handlePointsMessage({ body: envelope(baseMsg({ yz_open_id: "" })) }, d);
  assert.equal(d.store.rows[0].initial_status, "blocked");
  assert.equal(d.store.rows[0].initial_reason, "missing_member_identity");
});

test("client_hash = md5(本应用 client_id)：blocked own_operation_loop 防回环", async () => {
  const d = deps();
  await handlePointsMessage({ body: envelope(baseMsg({ client_hash: md5(CID) })) }, d);
  assert.equal(d.store.rows[0].initial_reason, "own_operation_loop");
});

test("正常消息也只进 pending，不含任何记账字段", async () => {
  const d = deps();
  await handlePointsMessage({ body: envelope(baseMsg()) }, d);
  assert.equal(d.store.rows[0].initial_status, "pending");
});

test("落库失败：503 不 ack，不回显内部错误", async () => {
  const st = memStore();
  st.fail = true;
  const r = await handlePointsMessage({ body: envelope(baseMsg()) }, deps(st));
  assert.equal(r.status, 503);
  assert.notEqual((r.body as { code: number }).code, 0);
  assert.ok(!JSON.stringify(r.body).includes("xyz"));
});

test("hook 只把 POINTS 分流到收件箱，且位于旧验签之前；交易/退款分支保留", () => {
  const src = readFileSync(new URL("../routes/api/public/hooks/youzan-message.ts", import.meta.url), "utf8");
  const points = src.indexOf('payload.type === "POINTS"');
  const legacy = src.indexOf("// ===== 验签 =====");
  assert.ok(points > 0 && points < legacy);
  assert.ok(src.includes('type === "TRADE_TradePaid"'));
  assert.ok(src.includes('type === "REFUND_RefundSuccess"'));
});

test("POINTS client_id 严格标量 / body null 数组 400", async () => {
  const { handlePointsMessage: h } = await import("./youzan-points-message.server");
  const d = { store: { ingest: async () => ({ result: "accepted" as const, id: "x" }) }, creds: { clientId: "c", clientSecret: "s" }, isActiveShop: async () => true };
  assert.equal((await h({ body: null as never }, d)).status, 400);
  assert.equal((await h({ body: [] as never }, d)).status, 400);
  const raw = JSON.stringify({ unique_id: "u1", yz_open_id: "o" });
  const sign = createHash("md5").update(`c${raw}s`).digest("hex");
  const r = await h({ body: { type: "POINTS", kdt_id: 1, msg: encodeURIComponent(raw), sign, client_id: { x: 1 } } }, d);
  assert.equal(r.status, 401);
});

test("hook：JSON null/数组直接 400", () => {
  const src = readFileSync(new URL("../routes/api/public/hooks/youzan-message.ts", import.meta.url), "utf8");
  assert.match(src, /Array\.isArray\(payload\)/);
});
