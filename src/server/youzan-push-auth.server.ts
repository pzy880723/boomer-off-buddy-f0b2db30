// 有赞消息推送鉴权 —— 两种协议严格区分，绝不互相回退。
// 1) 现行协议（官方 ZnS3wHtzOiuGNMkB31bcHr9jnUc）：请求头 Event-Sign = MD5(client_id + 原始 HTTP RequestBody + client_secret)。
//    只要带了 Event-Sign 头，就只验原始 body 字节；失败直接 401，不准回退 body.sign。
//    Client-Id 头若存在必须等于配置；Event-Type 头若存在必须等于 body.type；body.client_id 若存在必须严格标量且一致。
// 2) legacy：无 Event-Sign 头，按 body.sign + 解码后 msg 校验（各消息模块内实现）。
//    legacy 通过的消息只作只读提示，入库即 blocked legacy_signature_readonly_hint，不会被资产处理器认领。
import { createHash, timingSafeEqual } from "node:crypto";
import { fail, isPlainBody, strictClientId, type Out } from "./youzan-points-message.server";

export type PushAuth = { protocol: "event_sign" } | { protocol: "legacy_body_sign" };
export type ParsedPush = { raw: string; body: unknown; headers: Headers };

/** 只读一次 request.text()；按 content-type 解析，原文原样保留给验签。 */
export async function readYouzanPush(request: Request): Promise<ParsedPush | null> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  const ct = request.headers.get("content-type") ?? "";
  let body: unknown;
  try {
    body = ct.includes("application/json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return null;
  }
  return { raw, body, headers: request.headers };
}

function md5Equal(sign: string, input: string) {
  if (!/^[0-9a-fA-F]{32}$/.test(sign)) return false;
  return timingSafeEqual(Buffer.from(sign, "hex"), createHash("md5").update(input, "utf8").digest());
}

export function authenticatePush(
  p: ParsedPush,
  creds: { clientId: string; clientSecret: string },
): { ok: true; auth: PushAuth; body: Record<string, unknown> } | { ok: false; out: Out } {
  const { clientId, clientSecret } = creds;
  if (!clientId || !clientSecret) return { ok: false, out: fail(503, "sign_not_configured") };
  if (!isPlainBody(p.body)) return { ok: false, out: fail(400, "invalid_body") };
  const body = p.body;
  const eventSign = p.headers.get("event-sign");
  if (eventSign === null) return { ok: true, auth: { protocol: "legacy_body_sign" }, body };

  if (!md5Equal(eventSign.trim(), `${clientId}${p.raw}${clientSecret}`)) {
    return { ok: false, out: fail(401, "invalid_event_sign") };
  }
  const hCid = p.headers.get("client-id");
  if (hCid !== null && hCid.trim() !== clientId) return { ok: false, out: fail(401, "client_id_mismatch") };
  const bCid = strictClientId(body.client_id);
  if (bCid === false || (bCid !== null && bCid !== clientId)) return { ok: false, out: fail(401, "client_id_mismatch") };
  const hType = p.headers.get("event-type");
  if (hType !== null && hType.trim() !== String(body.type ?? "")) return { ok: false, out: fail(401, "event_type_mismatch") };
  return { ok: true, auth: { protocol: "event_sign" }, body };
}

/**
 * TRADE_* 推送鉴权：有 Event-Sign 头只验原始 body（不回退）；无头才验 legacy body.sign。
 * 推送仅作为触发提示，扣减前仍以 trade.get 详情或已入库订单为准。
 */
export function authorizeTradePush(
  p: ParsedPush,
  creds: { clientId: string; clientSecret: string },
): { ok: true; auth: PushAuth; body: Record<string, unknown> } | { ok: false; out: Out } {
  const r = authenticatePush(p, creds);
  if (!r.ok || r.auth.protocol === "event_sign") return r;
  const sign = typeof r.body.sign === "string" ? r.body.sign : "";
  const msg = typeof r.body.msg === "string" ? r.body.msg : "";
  let decoded = msg;
  try { decoded = decodeURIComponent(msg); } catch { /* keep raw */ }
  const valid = md5Equal(sign, `${creds.clientId}${msg}${creds.clientSecret}`) ||
    (decoded !== msg && md5Equal(sign, `${creds.clientId}${decoded}${creds.clientSecret}`));
  return valid ? r : { ok: false, out: fail(401, "invalid_sign") };
}

export type AssetPushDeps = Parameters<typeof import("./youzan-points-message.server").handlePointsMessage>[1];

/** POINTS / COUPON_CUSTOMER_PROMOTION 分流；其它 type 返回 null 交回旧逻辑。 */
export async function dispatchAssetPush(p: ParsedPush, deps: AssetPushDeps): Promise<Out | null> {
  const type = isPlainBody(p.body) ? p.body.type : undefined;
  if (type !== "POINTS" && type !== "COUPON_CUSTOMER_PROMOTION") return null;
  const a = authenticatePush(p, deps.creds);
  if (!a.ok) return a.out;
  if (type === "POINTS") {
    const { handlePointsMessage } = await import("./youzan-points-message.server");
    return handlePointsMessage({ body: a.body, auth: a.auth }, deps);
  }
  const { handleCouponMessage } = await import("./youzan-coupon-message.server");
  return handleCouponMessage({ body: a.body, auth: a.auth }, deps);
}
