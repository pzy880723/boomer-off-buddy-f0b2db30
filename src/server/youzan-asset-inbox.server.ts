// 有赞会员资产（积分/券）消息收件箱 —— 底座。
// 只做：验签 → 唯一事件身份去重 → 载荷冲突保护 → 延迟重试 → 身份解析。
// 不做：任何扣账/加积分/发券/核销/写有赞。状态集合里不存在“成功”，
// 资产适配器接通前，所有可处理消息最多到 blocked。
// 未确认官方积分/券消息 type 枚举前，不挂公网入口（见 docs/youzan-asset-inbox-20261005.md）。
import { createHash, timingSafeEqual } from "node:crypto";

export const INBOX_STATUSES = ["pending", "processing", "retry", "blocked", "dead"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 5 * 60_000;
const SAFE_TRANSIENT = "transient_error";

export type InboxRow = {
  id: string;
  kdt_id: number;
  event_id: string;
  msg_type: string;
  payload_hash: string;
  payload: unknown;
  status: InboxStatus;
  attempts: number;
  next_attempt_at: number;
  reason?: string | null;
  claim_token?: string | null;
  lease_until?: number | null;
};

export type IngestResult = "accepted" | "duplicate" | "conflict";

export interface InboxStore {
  ingest(i: {
    kdt_id: number;
    event_id: string;
    msg_type: string;
    payload_hash: string;
    payload: unknown;
  }): Promise<{ result: IngestResult; id: string }>;
  claim(limit: number, now: number): Promise<InboxRow[]>;
  /** 只有持有当前 claim_token 且 lease 未过期才生效；否则返回 false（被抢占/已重排）。 */
  finish(id: string, claimToken: string, status: InboxStatus, reason: string | null, nextAttemptAt: number, now: number): Promise<boolean>;
  requeue(id: string): Promise<void>;
}

export type MemberResolution = { kind: "found"; customerId: string } | { kind: "unknown" };
export type ProcessDeps = {
  resolveMember(row: InboxRow): Promise<MemberResolution>;
};

export function verifyYouzanSign(msg: string, sign: string, clientId: string, clientSecret: string) {
  if (typeof sign !== "string" || !/^[0-9a-fA-F]{32}$/.test(sign)) return false;
  const expected = createHash("md5").update(`${clientId}${msg}${clientSecret}`).digest();
  return timingSafeEqual(Buffer.from(sign, "hex"), expected);
}

export function retryDelayMs(attempt: number) {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

type RawMessage = { id?: unknown; kdt_id?: unknown; type?: unknown; msg?: unknown; sign?: unknown };

export async function ingestAssetMessage(
  store: InboxStore,
  body: RawMessage,
  creds: { clientId: string; clientSecret: string },
): Promise<{ status: number; result?: IngestResult; id?: string; code?: string }> {
  if (!creds.clientId || !creds.clientSecret) return { status: 503, code: "sign_not_configured" };
  const msg = typeof body.msg === "string" ? body.msg : "";
  if (!verifyYouzanSign(msg, String(body.sign ?? ""), creds.clientId, creds.clientSecret)) {
    return { status: 401, code: "invalid_sign" };
  }
  const eventId =
    typeof body.id === "string" ? body.id.trim()
    : typeof body.id === "number" && Number.isSafeInteger(body.id) ? String(body.id) : "";
  const kdtId =
    typeof body.kdt_id === "number" ? body.kdt_id
    : typeof body.kdt_id === "string" && /^[1-9][0-9]{0,15}$/.test(body.kdt_id) ? Number(body.kdt_id) : NaN;
  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (!eventId || !Number.isSafeInteger(kdtId) || kdtId <= 0 || !type || eventId.length > 128 || type.length > 128) {
    return { status: 422, code: "missing_event_identity" };
  }
  let payload: unknown;
  try {
    payload = msg ? JSON.parse(msg) : {};
  } catch {
    return { status: 422, code: "invalid_msg_json" };
  }
  const payloadHash = createHash("sha256").update(`${type}\n${msg}`).digest("hex");
  const r = await store.ingest({ kdt_id: kdtId, event_id: eventId, msg_type: type, payload_hash: payloadHash, payload });
  return { status: r.result === "conflict" ? 409 : 200, result: r.result, id: r.id, code: r.result };
}

export async function processAssetInbox(
  store: InboxStore,
  deps: ProcessDeps,
  opts: { now?: number; limit?: number } = {},
) {
  const now = opts.now ?? Date.now();
  const rows = await store.claim(opts.limit ?? 20, now);
  const out = { claimed: rows.length, blocked: 0, retry: 0, dead: 0, stale: 0 };
  const finish = async (row: InboxRow, st: InboxStatus, reason: string, next: number, key: "blocked" | "retry" | "dead") => {
    if (await store.finish(row.id, row.claim_token ?? "", st, reason, next, now)) out[key]++;
    else out.stale++;
  };
  for (const row of rows) {
    try {
      const m = await deps.resolveMember(row);
      // 资产适配器（积分冻结/消耗/回补、券查询/核销/退还）未接通：一律 blocked，绝不记成功。
      const reason = m.kind === "unknown" ? "unknown_member" : "asset_adapter_not_connected";
      await finish(row, "blocked", reason, now, "blocked");
    } catch (e) {
      // 固定安全代码；不复制 message/name（都可能被塞入令牌）。
      void e;
      if (row.attempts >= MAX_ATTEMPTS) await finish(row, "dead", SAFE_TRANSIENT, now, "dead");
      else await finish(row, "retry", SAFE_TRANSIENT, now + retryDelayMs(row.attempts), "retry");
    }
  }
  return out;
}

/** 生产存储：只经 service_role 调用 SQL 函数（anon/authenticated 无执行权）。 */
export async function supabaseInboxStore(): Promise<InboxStore> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await supabaseAdmin.rpc(fn as never, args as never);
    if (error) throw new Error(error.message);
    return data as unknown;
  };
  return {
    async ingest(i) {
      return (await rpc("youzan_asset_inbox_ingest", {
        p_kdt_id: i.kdt_id, p_event_id: i.event_id, p_msg_type: i.msg_type,
        p_payload_hash: i.payload_hash, p_payload: i.payload,
      })) as { result: IngestResult; id: string };
    },
    async claim(limit) {
      const rows = (await rpc("youzan_asset_inbox_claim", { p_limit: limit })) as Array<
        Omit<InboxRow, "next_attempt_at" | "lease_until"> & { next_attempt_at: string; lease_until: string | null }
      >;
      return (rows ?? []).map((r) => ({
        ...r,
        next_attempt_at: Date.parse(r.next_attempt_at),
        lease_until: r.lease_until ? Date.parse(r.lease_until) : null,
      }));
    },
    async finish(id, token, status, reason, next) {
      // lease 过期判断以数据库 now() 为准，参数 now 仅用于内存实现。
      return (await rpc("youzan_asset_inbox_finish", {
        p_id: id, p_claim_token: token, p_status: status, p_reason: reason,
        p_next_attempt_at: new Date(next).toISOString(),
      })) === true;
    },
    async requeue(id) {
      await rpc("youzan_asset_inbox_requeue", { p_id: id });
    },
  };
}
