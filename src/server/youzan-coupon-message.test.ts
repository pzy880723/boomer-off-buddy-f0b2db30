import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUYER_COUPON_STATUSES, handleCouponMessage } from "./youzan-coupon-message.server";
import type { PointsIngest } from "./youzan-points-message.server";

const CID = "3931c2c6b39ccc0673";
const SECRET = "sec";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const creds = { clientId: CID, clientSecret: SECRET };

const msgOf = (o: Record<string, unknown> = {}) => ({
  id: "10887216",
  type: "COUPON_CUSTOMER_PROMOTION",
  status: "CARD_TAKE",
  fans_id: 0,
  mobile: "15168266350",
  event_time: "2026-10-05 11:56:08",
  verify_code: "ZAN3466537296698",
  ...o,
});

function envelope(m: Record<string, unknown>, o: Record<string, unknown> = {}) {
  const raw = JSON.stringify(m);
  return {
    client_id: CID,
    id: String(m.id),
    kdt_id: 153242272,
    type: "COUPON_CUSTOMER_PROMOTION",
    status: m.status,
    version: 1759636568,
    sendCount: 0,
    yz_open_id: "L1n4Ilgs876832027528159423",
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
      if (this.fail) throw new Error("db down token=abc");
      const hit = rows.find((r) => r.kdt_id === i.kdt_id && r.event_id === i.event_id);
      if (hit) return { result: hit.payload_hash === i.payload_hash ? ("duplicate" as const) : ("conflict" as const), id: hit.id };
      const row = { ...i, id: `r${rows.length + 1}` };
      rows.push(row);
      return { result: "accepted" as const, id: row.id };
    },
  };
}
const deps = (store = memStore(), active = true) => ({ store, creds, isActiveShop: async () => active });
const run = (d: ReturnType<typeof deps>, m: Record<string, unknown>, o: Record<string, unknown> = {}) =>
  handleCouponMessage({ body: envelope(m, o) }, d);

test("8 种买家 status 全部接收", async () => {
  assert.deepEqual([...BUYER_COUPON_STATUSES].sort(), [
    "CARD_BACK", "CARD_CONSUME", "CARD_REVERT", "CARD_TAKE", "CODE_BACK", "CODE_CONSUME", "CODE_REVERT", "CODE_TAKE",
  ]);
  const d = deps();
  for (const s of BUYER_COUPON_STATUSES) assert.equal((await run(d, msgOf({ status: s }))).status, 200, s);
  assert.equal(d.store.rows.length, 8);
});

test("同一张券 领取→核销→退还 三条都保存，不被券 id 吞掉", async () => {
  const d = deps();
  await run(d, msgOf({ status: "CARD_TAKE" }), { version: 100 });
  await run(d, msgOf({ status: "CARD_CONSUME", order_no: "E1", event_time: "2026-10-05 12:00:00" }), { version: 200 });
  await run(d, msgOf({ status: "CARD_REVERT", order_no: "E1", event_time: "2026-10-05 13:00:00" }), { version: 300 });
  assert.equal(d.store.rows.length, 3);
  assert.equal(new Set(d.store.rows.map((r) => r.event_id)).size, 3);
  assert.ok(d.store.rows.every((r) => r.biz_id === "10887216" && r.event_id !== "10887216"));
});

test("sendCount 重推同一事件：duplicate 并 ack", async () => {
  const d = deps();
  await run(d, msgOf(), { sendCount: 0 });
  const r = await run(d, msgOf(), { sendCount: 4 });
  assert.equal(r.status, 200);
  assert.equal(r.result, "duplicate");
  assert.equal(d.store.rows.length, 1);
});

test("同事件指纹但内容不同：409 冲突", async () => {
  const d = deps();
  await run(d, msgOf({ verify_code: "A" }));
  const r = await run(d, msgOf({ verify_code: "B" }));
  assert.equal(r.status, 409);
  assert.notEqual((r.body as { code: number }).code, 0);
});

test("商家活动事件（msg.type=COUPON_PROMOTION 或商家 status）不当用户券，不入库", async () => {
  const d = deps();
  const a = await run(d, msgOf({ type: "COUPON_PROMOTION", status: "CARD_CREATED" }));
  const b = await run(d, msgOf({ status: "CARD_GROUP_INVALID" }));
  assert.equal(a.status, 200);
  assert.equal(a.result, "ignored");
  assert.equal(b.result, "ignored");
  assert.equal(d.store.rows.length, 0);
});

test("外层 status 与 msg.status 不一致：422", async () => {
  const d = deps();
  const r = await run(d, msgOf({ status: "CARD_TAKE" }), { status: "CARD_CONSUME" });
  assert.equal(r.status, 422);
  assert.equal(d.store.rows.length, 0);
});

test("无 yz_open_id 仅有手机号：blocked missing_member_identity，手机号脱敏", async () => {
  const d = deps();
  await run(d, msgOf(), { yz_open_id: undefined });
  const row = d.store.rows[0];
  assert.equal(row.initial_status, "blocked");
  assert.equal(row.initial_reason, "missing_member_identity");
  assert.ok(!JSON.stringify(row).includes("15168266350"));
});

test("有 yz_open_id：pending，envelope 保留 yz_open_id/version/sendCount/status", async () => {
  const d = deps();
  await handleCouponMessage({ body: envelope(msgOf(), { sendCount: 1 }), auth: { protocol: "event_sign" } }, d);
  const row = d.store.rows[0];
  assert.equal(row.initial_status, "pending");
  assert.equal(row.msg_type, "COUPON_CUSTOMER_PROMOTION");
  assert.equal(row.msg_version, "1759636568");
  const env = row.envelope as Record<string, unknown>;
  assert.equal(env.yz_open_id, "L1n4Ilgs876832027528159423");
  assert.equal(env.send_count, 1);
  assert.equal(env.status, "CARD_TAKE");
});

test("验签：按编码原文签名 401；client_id 不一致 401；非 active 店铺 blocked", async () => {
  const d = deps();
  const raw = JSON.stringify(msgOf());
  const enc = encodeURIComponent(raw);
  assert.equal((await run(d, msgOf(), { msg: enc, sign: md5(`${CID}${enc}${SECRET}`) })).status, 401);
  assert.equal((await run(d, msgOf(), { client_id: "x" })).status, 401);
  assert.equal(d.store.rows.length, 0);
  const d2 = deps(memStore(), false);
  await run(d2, msgOf());
  assert.equal(d2.store.rows[0].initial_reason, "shop_not_authorized");
});

test("未知 status / 缺券 id：422；落库失败 503 不 ack", async () => {
  const d = deps();
  assert.equal((await run(d, msgOf({ status: "CARD_WHATEVER" }), { status: "CARD_WHATEVER" })).status, 422);
  assert.equal((await run(d, msgOf({ id: "" }), { id: "" })).status, 422);
  const st = memStore();
  st.fail = true;
  const r = await run(deps(st), msgOf());
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.body).includes("abc"));
});

test("hook 分流 COUPON_CUSTOMER_PROMOTION（在旧验签前），不分流 COUPON_PROMOTION", () => {
  const src = readFileSync(new URL("../routes/api/public/hooks/youzan-message.ts", import.meta.url), "utf8");
  const i = src.indexOf('payload.type === "COUPON_CUSTOMER_PROMOTION"');
  assert.ok(i > 0 && i < src.indexOf("// ===== 验签 ====="));
  assert.ok(!src.includes('payload.type === "COUPON_PROMOTION"'));
});

test("client_id 严格标量：对象/数组/布尔 401", async () => {
  for (const bad of [{ a: 1 }, [CID], true]) {
    const d = deps();
    assert.equal((await run(d, msgOf(), { client_id: bad })).status, 401, JSON.stringify(bad));
    assert.equal(d.store.rows.length, 0);
  }
});

test("body 为 null/数组：400", async () => {
  const d = deps();
  assert.equal((await handleCouponMessage({ body: null as never }, d)).status, 400);
  assert.equal((await handleCouponMessage({ body: [] as never }, d)).status, 400);
});

test("缺 version 或 event_time：弱身份不合并两条合法事件，并 blocked weak_event_identity", async () => {
  const d = deps();
  await run(d, msgOf({ event_time: undefined, verify_code: "A" }), { version: undefined });
  await run(d, msgOf({ event_time: undefined, verify_code: "B" }), { version: undefined });
  assert.equal(d.store.rows.length, 2);
  assert.ok(d.store.rows.every((r) => r.initial_reason === "weak_event_identity" && r.event_id.length <= 128));
});

test("核销/退回缺 order_no：弱身份", async () => {
  const d = deps();
  await run(d, msgOf({ status: "CARD_CONSUME" }), { status: "CARD_CONSUME" });
  assert.equal(d.store.rows[0].initial_reason, "weak_event_identity");
});
