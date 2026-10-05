// 有赞 POINTS（客户积分变更，MSG/279）消息接收 —— 只收件，不记账。
// 官方合同要点：
// - msg 是 UrlEncode(UTF-8) 后的 JSON，需要解码；
// - msg.unique_id 才是消息唯一性标识；外层 id 是业务标识（如 yuser_xxx），同一客户多次变动相同，不能拿来去重；
// - 外层 version 用于顺序（高版本覆盖低版本），sendCount 是重推次数（同一事件）；
// - msg.total 是当前积分（保护期内不增加），msg.amount 不能当本地增减 delta；
// - msg.client_hash = md5(client_id)，等于本应用即自己通过接口的操作，需防回环。
// 签名：有赞云团队给出的推送验签步骤 —— 先 URLDecode msg，再 MD5(client_id + 解码后 msg + client_secret)，
// 与 body.sign 或 Event-Sign 头比对。只用这一种算法，不做多方案宽松通过。
import { createHash, timingSafeEqual } from "node:crypto";
import type { IngestResult } from "./youzan-asset-inbox.server";

export type PointsIngest = {
  kdt_id: number;
  event_id: string; // msg.unique_id
  msg_type: "POINTS" | "COUPON_CUSTOMER_PROMOTION";
  payload_hash: string;
  payload: Record<string, unknown>;
  biz_id: string | null; // 外层 id
  msg_version: string | null; // 外层 version（字符串保精度）
  envelope: Record<string, unknown>;
  initial_status: "pending" | "blocked";
  initial_reason: string | null;
};

export type PointsDeps = {
  store: { ingest(i: PointsIngest): Promise<{ result: IngestResult; id: string }> };
  creds: { clientId: string; clientSecret: string };
  isActiveShop(kdtId: number): Promise<boolean>;
};

export type Out = { status: number; body: Record<string, unknown>; result?: IngestResult };
export const fail = (status: number, code: string): Out => ({ status, body: { code: status, message: code } });

export const md5hex = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

export function signOk(decoded: string, sign: unknown, clientId: string, secret: string) {
  if (typeof sign !== "string" || !/^[0-9a-fA-F]{32}$/.test(sign)) return false;
  const expected = createHash("md5").update(`${clientId}${decoded}${secret}`, "utf8").digest();
  return timingSafeEqual(Buffer.from(sign, "hex"), expected);
}

/** UrlEncode(UTF-8) 解码；兼容 Java URLEncoder 的 "+" 表示空格。损坏返回 null。 */
export function decodeYouzanMsg(msg: unknown): string | null {
  if (typeof msg !== "string") return null;
  try {
    return decodeURIComponent(msg.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

export const scalarStr = (v: unknown) =>
  typeof v === "string" ? v.trim() : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : "";

/** client_id 只接受非空字符串或安全整数；对象/数组/布尔视为非法。缺省返回 null。 */
export function strictClientId(v: unknown): string | null | false {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v)) return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  return false;
}

export const isPlainBody = (b: unknown): b is Record<string, unknown> =>
  !!b && typeof b === "object" && !Array.isArray(b);

export function maskMobile(v: unknown) {
  const s = typeof v === "string" ? v : "";
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s ? "****" : s;
}

export async function handlePointsMessage(
  input: { body: Record<string, unknown>; auth?: { protocol: "event_sign" | "legacy_body_sign" } },
  deps: PointsDeps,
): Promise<Out> {
  const { clientId, clientSecret } = deps.creds;
  if (!clientId || !clientSecret) return fail(503, "sign_not_configured");
  if (!isPlainBody(input.body)) return fail(400, "invalid_body");
  const body = input.body;
  if (body.type !== "POINTS") return fail(422, "not_points_message");

  const decoded = decodeYouzanMsg(body.msg);
  if (decoded === null) return fail(400, "invalid_msg_encoding");
  // event_sign：路由层已对原始 HTTP body 验过 Event-Sign。否则只按 legacy body.sign 验，绝不读请求头回退。
  const protocol = input.auth?.protocol === "event_sign" ? "event_sign" : "legacy_body_sign";
  if (protocol === "legacy_body_sign" && !signOk(decoded, body.sign, clientId, clientSecret)) return fail(401, "invalid_sign");
  // 文档示例未带 client_id；签名已绑定本应用密钥。若带了就必须一致。
  const cid = strictClientId(body.client_id);
  if (cid === false || (cid !== null && cid !== clientId)) return fail(401, "client_id_mismatch");

  let msg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(422, "invalid_msg_json");
    msg = parsed as Record<string, unknown>;
  } catch {
    return fail(422, "invalid_msg_json");
  }

  const kdtRaw = body.kdt_id;
  const kdtId =
    typeof kdtRaw === "number" ? kdtRaw
    : typeof kdtRaw === "string" && /^[1-9][0-9]{0,15}$/.test(kdtRaw) ? Number(kdtRaw) : NaN;
  const uniqueId = scalarStr(msg.unique_id);
  if (!Number.isSafeInteger(kdtId) || kdtId <= 0) return fail(422, "missing_kdt_id");
  if (!uniqueId || uniqueId.length > 128) return fail(422, "missing_unique_id");
  const versionStr = scalarStr(body.version);
  const version = /^[0-9]{1,19}$/.test(versionStr) ? versionStr : null;
  const bizId = scalarStr(body.id).slice(0, 128) || null;
  const sendCount = Number.isSafeInteger(Number(body.sendCount)) ? Number(body.sendCount) : null;

  // 分类：只决定初始状态，不做任何资产动作。
  let initialStatus: PointsIngest["initial_status"] = "pending";
  let initialReason: string | null = null;
  let active: boolean;
  try {
    active = await deps.isActiveShop(kdtId);
  } catch {
    return fail(503, "shop_lookup_unavailable");
  }
  if (!active) {
    initialStatus = "blocked"; initialReason = "shop_not_authorized";
  } else if (typeof msg.client_hash === "string" && msg.client_hash.toLowerCase() === md5hex(clientId)) {
    initialStatus = "blocked"; initialReason = "own_operation_loop";
  } else if (!scalarStr(msg.yz_open_id)) {
    initialStatus = "blocked"; initialReason = "missing_member_identity";
  }

  const payload = { ...msg, mobile: maskMobile(msg.mobile) };
  if (msg.mobile === undefined) delete (payload as Record<string, unknown>).mobile;

  try {
    const r = await deps.store.ingest({
      kdt_id: kdtId,
      event_id: uniqueId,
      msg_type: "POINTS",
      // 指纹只覆盖解码后的 msg 原文；sendCount/外层字段变化不影响事件身份。
      payload_hash: createHash("sha256").update(`POINTS\n${decoded}`, "utf8").digest("hex"),
      payload,
      biz_id: bizId,
      msg_version: version,
      envelope: { auth_protocol: protocol, biz_id: bizId, version, send_count: sendCount, kdt_name: scalarStr(body.kdt_name) || null },
      // legacy 签名只作只读提示：一律 blocked，不进入资产处理。
      initial_status: protocol === "legacy_body_sign" ? "blocked" : initialStatus,
      initial_reason: protocol === "legacy_body_sign" ? "legacy_signature_readonly_hint" : initialReason,
    });
    if (r.result === "conflict") return { status: 409, body: { code: 409, message: "unique_id_payload_conflict" }, result: r.result };
    return { status: 200, body: { code: 0, msg: "success" }, result: r.result };
  } catch {
    // 落库失败不能 ack，让有赞按 sendCount 重推。
    return fail(503, "inbox_unavailable");
  }
}

/** 生产依赖：service_role RPC + 授权 active 店铺校验。 */
export async function productionPointsDeps(): Promise<PointsDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return {
    creds: { clientId: process.env.YOUZAN_CLIENT_ID ?? "", clientSecret: process.env.YOUZAN_CLIENT_SECRET ?? "" },
    async isActiveShop(kdtId) {
      const { data, error } = await supabaseAdmin
        .from("youzan_shops").select("id").eq("kdt_id", kdtId).eq("status", "active").maybeSingle();
      if (error) throw new Error("shop lookup failed");
      return !!data;
    },
    store: {
      async ingest(i) {
        const { data, error } = await supabaseAdmin.rpc("youzan_asset_inbox_ingest" as never, {
          p_kdt_id: i.kdt_id, p_event_id: i.event_id, p_msg_type: i.msg_type,
          p_payload_hash: i.payload_hash, p_payload: i.payload,
          p_biz_id: i.biz_id, p_msg_version: i.msg_version, p_envelope: i.envelope,
          p_initial_status: i.initial_status, p_initial_reason: i.initial_reason,
        } as never);
        if (error) throw new Error("inbox ingest failed");
        return data as unknown as { result: IngestResult; id: string };
      },
    },
  };
}
