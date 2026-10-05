// 有赞 COUPON_CUSTOMER_PROMOTION（买家优惠券/码事件）接收 —— 只收件，不改券资产。
// 官方合同：VsTMw2pLTiECtrkcrxOcQbtCnng + resource/doc/3789
// - 外层 id = 券/码 id（不是事件 id），同一张券 领取→核销→退还 共用，不能单独去重；
// - version = 推送秒级时间戳，只在同 type 内比较顺序，不能替代事件身份；
// - 订阅同时会推商家活动事件（msg.type=COUPON_PROMOTION，id=活动 id），不能当用户券，直接忽略；
// - 官方无事件唯一 id：事件身份 = sha256(店铺+type+券id+status+version+order_no+event_time)；
//   同身份内容不同 → 冲突，由数据库阻断待人工检查；
// - 会员身份只认外层 yz_open_id；没有就 blocked，绝不凭手机号建会员。
// 签名与 POINTS 相同：MD5(client_id + 解码后 msg + client_secret)。
import { createHash } from "node:crypto";
import {
  decodeYouzanMsg, fail, isPlainBody, maskMobile, scalarStr, signOk, strictClientId,
  type Out, type PointsDeps, type PointsIngest,
} from "./youzan-points-message.server";

export const BUYER_COUPON_STATUSES = [
  "CARD_TAKE", "CARD_CONSUME", "CARD_BACK", "CARD_REVERT",
  "CODE_TAKE", "CODE_CONSUME", "CODE_BACK", "CODE_REVERT",
] as const;
const BUYER = new Set<string>(BUYER_COUPON_STATUSES);
// 商家端 status（官方 20 种）——出现即视为活动事件忽略。
const MERCHANT = /^(CARD|CODE)_(CREATED|UPDATED|GROUP_INVALID|EXPIRED|GROUP_DELETE|APPROVE_[A-Z_]+)$|^(UPDATED_CARD|CREATED_CARD)$/;
const TYPE = "COUPON_CUSTOMER_PROMOTION";

export async function handleCouponMessage(
  input: { body: Record<string, unknown>; headerSign?: string | null },
  deps: PointsDeps,
): Promise<Out> {
  const { clientId, clientSecret } = deps.creds;
  if (!clientId || !clientSecret) return fail(503, "sign_not_configured");
  if (!isPlainBody(input.body)) return fail(400, "invalid_body");
  const body = input.body;
  if (body.type !== TYPE) return fail(422, "not_coupon_customer_message");

  const decoded = decodeYouzanMsg(body.msg);
  if (decoded === null) return fail(400, "invalid_msg_encoding");
  const sign = typeof body.sign === "string" && body.sign ? body.sign : input.headerSign;
  if (!signOk(decoded, sign, clientId, clientSecret)) return fail(401, "invalid_sign");
  const cid = strictClientId(body.client_id);
  if (cid === false || (cid !== null && cid !== clientId)) return fail(401, "client_id_mismatch");

  let msg: Record<string, unknown>;
  try {
    const p = JSON.parse(decoded);
    if (!p || typeof p !== "object" || Array.isArray(p)) return fail(422, "invalid_msg_json");
    msg = p as Record<string, unknown>;
  } catch {
    return fail(422, "invalid_msg_json");
  }

  const status = scalarStr(msg.status);
  // 商家活动事件：活动 id 不是用户券，验签通过后 ack 但不入库。
  if (msg.type === "COUPON_PROMOTION" || MERCHANT.test(status)) {
    return { status: 200, body: { code: 0, msg: "success" }, result: "ignored" as never };
  }
  if (msg.type !== undefined && msg.type !== TYPE) return fail(422, "unexpected_msg_type");
  if (!BUYER.has(status)) return fail(422, "unknown_coupon_status");
  const outerStatus = scalarStr(body.status);
  if (outerStatus && outerStatus !== status) return fail(422, "status_mismatch");

  const kdtRaw = body.kdt_id;
  const kdtId =
    typeof kdtRaw === "number" ? kdtRaw
    : typeof kdtRaw === "string" && /^[1-9][0-9]{0,15}$/.test(kdtRaw) ? Number(kdtRaw) : NaN;
  if (!Number.isSafeInteger(kdtId) || kdtId <= 0) return fail(422, "missing_kdt_id");
  const voucherId = scalarStr(msg.id) || scalarStr(body.id);
  if (!voucherId || voucherId.length > 128) return fail(422, "missing_voucher_id");
  const outerId = scalarStr(body.id);
  if (outerId && scalarStr(msg.id) && outerId !== scalarStr(msg.id)) return fail(422, "voucher_id_mismatch");
  const versionStr = scalarStr(body.version);
  const version = /^[0-9]{1,19}$/.test(versionStr) ? versionStr : null;
  const orderNo = scalarStr(msg.order_no).slice(0, 64);
  const eventTime = scalarStr(msg.event_time).slice(0, 40);
  const sendCount = Number.isSafeInteger(Number(body.sendCount)) ? Number(body.sendCount) : null;
  const yzOpenId = scalarStr(body.yz_open_id).slice(0, 128);

  // 可信事件身份需要 version + event_time；核销/退回还需要 order_no。
  // 缺任一项：不能用残缺字段合并多条合法事件 → 身份带入解码原文，并阻断待人工检查。
  const needsOrder = /_(CONSUME|REVERT)$/.test(status);
  const weak = !version || !eventTime || (needsOrder && !orderNo);
  const idParts = [kdtId, TYPE, voucherId, status, version ?? "", orderNo, eventTime];
  if (weak) idParts.push(yzOpenId, decoded);
  const eventId = (weak ? "coupon-raw:" : "coupon:") + createHash("sha256")
    .update(idParts.join("\u0001"), "utf8").digest("hex");

  let active: boolean;
  try {
    active = await deps.isActiveShop(kdtId);
  } catch {
    return fail(503, "shop_lookup_unavailable");
  }
  let initialStatus: PointsIngest["initial_status"] = "pending";
  let initialReason: string | null = null;
  if (!active) { initialStatus = "blocked"; initialReason = "shop_not_authorized"; }
  else if (!yzOpenId) { initialStatus = "blocked"; initialReason = "missing_member_identity"; }
  else if (weak) { initialStatus = "blocked"; initialReason = "weak_event_identity"; }

  const payload: Record<string, unknown> = { ...msg };
  if (msg.mobile !== undefined) payload.mobile = maskMobile(msg.mobile);

  try {
    const r = await deps.store.ingest({
      kdt_id: kdtId,
      event_id: eventId,
      msg_type: TYPE,
      // 内容指纹覆盖解码后 msg 原文 + 外层 yz_open_id；sendCount 不影响。
      payload_hash: createHash("sha256").update(`${TYPE}\n${yzOpenId}\n${decoded}`, "utf8").digest("hex"),
      payload,
      biz_id: voucherId,
      msg_version: version,
      envelope: {
        voucher_id: voucherId, status, version, send_count: sendCount,
        yz_open_id: yzOpenId || null, order_no: orderNo || null, event_time: eventTime || null,
        kdt_name: scalarStr(body.kdt_name) || null,
      },
      initial_status: initialStatus,
      initial_reason: initialReason,
    });
    if (r.result === "conflict") return { status: 409, body: { code: 409, message: "coupon_event_payload_conflict" }, result: r.result };
    return { status: 200, body: { code: 0, msg: "success" }, result: r.result };
  } catch {
    return fail(503, "inbox_unavailable");
  }
}
