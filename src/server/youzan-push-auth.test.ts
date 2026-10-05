import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { authenticatePush, dispatchAssetPush, readYouzanPush } from "./youzan-push-auth.server";
import type { PointsIngest } from "./youzan-points-message.server";

const CID = "3931c2c6b39ccc0673";
const SECRET = "sec";
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const URL_ = "https://erp.example/api/public/hooks/youzan-message";

function deps() {
  const rows: PointsIngest[] = [];
  return {
    rows,
    creds: { clientId: CID, clientSecret: SECRET },
    isActiveShop: async () => true,
    store: {
      async ingest(i: PointsIngest) {
        const hit = rows.find((r) => r.event_id === i.event_id);
        if (hit) return { result: hit.payload_hash === i.payload_hash ? ("duplicate" as const) : ("conflict" as const), id: "x" };
        rows.push(i);
        return { result: "accepted" as const, id: `r${rows.length}` };
      },
    },
  };
}

const pointsMsg = encodeURIComponent(JSON.stringify({ unique_id: "u-1", yz_open_id: "OPEN1", total: 10, amount: 5 }));
const couponMsg = encodeURIComponent(JSON.stringify({
  id: "V9", type: "COUPON_CUSTOMER_PROMOTION", status: "CARD_TAKE", event_time: "2026-10-05 11:00:00",
}));
const pointsJson = `{"client_id":"${CID}","kdt_id":153242272,"type":"POINTS","id":"yuser_1","version":1759636568,"sendCount":0,"msg":"${pointsMsg}"}`;
const couponJson = `{"client_id":"${CID}","kdt_id":153242272,"type":"COUPON_CUSTOMER_PROMOTION","id":"V9","status":"CARD_TAKE","version":1759636568,"yz_open_id":"OPEN1","msg":"${couponMsg}"}`;

function req(raw: string, headers: Record<string, string>, ct = "application/json") {
  return new Request(URL_, { method: "POST", body: raw, headers: { "content-type": ct, ...headers } });
}
const signed = (raw: string, extra: Record<string, string> = {}) => ({ "Event-Sign": md5(`${CID}${raw}${SECRET}`), "Client-Id": CID, ...extra });

async function send(r: Request, d = deps()) {
  const p = await readYouzanPush(r);
  assert.ok(p);
  return { out: await dispatchAssetPush(p, d), d };
}

test("JSON + Event-Sign（原始 body）：接收 pending，auth_protocol=event_sign", async () => {
  const { out, d } = await send(req(pointsJson, signed(pointsJson, { "Event-Type": "POINTS" })));
  assert.equal(out?.status, 200);
  assert.equal(d.rows[0].initial_status, "pending");
  assert.equal((d.rows[0].envelope as { auth_protocol: string }).auth_protocol, "event_sign");
});

test("urlencoded + Event-Sign：对原始表单字节验签", async () => {
  const raw = new URLSearchParams({ client_id: CID, kdt_id: "153242272", type: "POINTS", id: "yuser_1", version: "1", msg: decodeURIComponent(pointsMsg) }).toString();
  const { out } = await send(req(raw, signed(raw), "application/x-www-form-urlencoded"));
  assert.equal(out?.status, 200);
});

test("签名后任一字节改动（空格/字段顺序/msg 编码）→ 401", async () => {
  const h = signed(pointsJson);
  const variants = [
    pointsJson.replace('"kdt_id":153242272', '"kdt_id": 153242272'),
    pointsJson.replace(`{"client_id":"${CID}","kdt_id":153242272`, `{"kdt_id":153242272,"client_id":"${CID}"`),
    pointsJson.replace(pointsMsg, pointsMsg.replace(/%22/g, "%22".toLowerCase().replace("2", "2"))).replace("%7B", "%7b"),
    pointsJson + " ",
  ];
  for (const v of variants) {
    assert.notEqual(v, pointsJson);
    const { out, d } = await send(req(v, h));
    assert.equal(out?.status, 401, v.slice(0, 60));
    assert.equal(d.rows.length, 0);
  }
});

test("伪造外层 yz_open_id（不在 msg 内）→ 401", async () => {
  const forged = couponJson.replace('"yz_open_id":"OPEN1"', '"yz_open_id":"ATTACKER"');
  const { out, d } = await send(req(forged, signed(couponJson)));
  assert.equal(out?.status, 401);
  assert.equal(d.rows.length, 0);
});

test("Event-Sign 错误但 body.sign 有效：仍 401，不回退", async () => {
  const decoded = decodeURIComponent(pointsMsg);
  const withLegacy = pointsJson.replace(/}$/, `,"sign":"${md5(`${CID}${decoded}${SECRET}`)}"}`);
  const { out, d } = await send(req(withLegacy, { "Event-Sign": "0".repeat(32) }));
  assert.equal(out?.status, 401);
  assert.equal(d.rows.length, 0);
});

test("Event-Sign 为空串也走现行协议 → 401", async () => {
  const { out } = await send(req(pointsJson, { "Event-Sign": "" }));
  assert.equal(out?.status, 401);
});

test("Client-Id / Event-Type 头与配置或 body 不一致 → 401", async () => {
  assert.equal((await send(req(pointsJson, signed(pointsJson, { "Client-Id": "other" })))).out?.status, 401);
  assert.equal((await send(req(pointsJson, signed(pointsJson, { "Event-Type": "trade_TradeSuccess" })))).out?.status, 401);
});

test("body.client_id 非严格标量（签名正确）→ 401", async () => {
  const raw = pointsJson.replace(`"client_id":"${CID}"`, `"client_id":{"v":"${CID}"}`);
  assert.equal((await send(req(raw, signed(raw)))).out?.status, 401);
});

test("优惠券 Event-Sign 正确：pending，外层 yz_open_id 原样保存为线索", async () => {
  const { out, d } = await send(req(couponJson, signed(couponJson, { "Event-Type": "COUPON_CUSTOMER_PROMOTION" })));
  assert.equal(out?.status, 200);
  assert.equal(d.rows[0].initial_status, "pending");
});

test("无 Event-Sign 头：legacy body.sign，入库即 blocked legacy_signature_readonly_hint", async () => {
  const decoded = decodeURIComponent(pointsMsg);
  const raw = pointsJson.replace(/}$/, `,"sign":"${md5(`${CID}${decoded}${SECRET}`)}"}`);
  const { out, d } = await send(req(raw, {}));
  assert.equal(out?.status, 200);
  assert.equal(d.rows[0].initial_reason, "legacy_signature_readonly_hint");
});

test("JSON null / 数组 → 400；非资产 type 交回旧逻辑", async () => {
  for (const raw of ["null", "[]"]) {
    const p = await readYouzanPush(req(raw, {}));
    assert.ok(p);
    const a = authenticatePush(p, { clientId: CID, clientSecret: SECRET });
    assert.equal(a.ok ? 0 : a.out.status, 400);
  }
  const t = `{"type":"trade_TradeSuccess"}`;
  assert.equal((await send(req(t, signed(t)))).out, null);
});
