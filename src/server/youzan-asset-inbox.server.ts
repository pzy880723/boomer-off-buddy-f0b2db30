// 有赞会员资产（积分/券）消息收件箱 —— 底座。
// 只做：验签 → 唯一事件身份去重 → 载荷冲突保护 → 延迟重试 → 身份解析。
// 不做：任何扣账/加积分/发券/核销/写有赞。状态集合里不存在“成功”，
// 资产适配器接通前，所有可处理消息最多到 blocked。
// 未确认官方积分/券消息 type 枚举前，不挂公网入口（见 docs/youzan-asset-inbox-20261005.md）。
import { createHash, timingSafeEqual } from "node:crypto";

export const INBOX_STATUSES = ["pending", "processing", "retry", "blocked", "dead"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const MAX_ATTEMPTS = 8;

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
  finish(id: string, status: InboxStatus, reason: string | null, nextAttemptAt: number): Promise<void>;
}

export type MemberResolution = { kind: "found"; customerId: string } | { kind: "unknown" };
export type ProcessDeps = {
  resolveMember(row: InboxRow): Promise<MemberResolution>;
};

export function verifyYouzanSign(msg: string, sign: string, clientId: string, clientSecret: string) {
  const expected = createHash("md5").update(`${clientId}${msg}${clientSecret}`).digest("hex");
  const got = String(sign ?? "").toLowerCase();
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
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
  const eventId = String(body.id ?? "").trim();
  const kdtId = Number(body.kdt_id);
  const type = String(body.type ?? "").trim();
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
  const out = { claimed: rows.length, blocked: 0, retry: 0, dead: 0 };
  for (const row of rows) {
    try {
      const m = await deps.resolveMember(row);
      // 资产适配器（积分冻结/消耗/回补、券查询/核销/退还）未接通：一律 blocked，绝不记成功。
      const reason = m.kind === "unknown" ? "unknown_member" : "asset_adapter_not_connected";
      await store.finish(row.id, "blocked", reason, now);
      out.blocked++;
    } catch (e) {
      // 只记安全的错误类别，不回写原始错误文本（可能含连接串/令牌）。
      const reason = `transient:${e instanceof Error ? e.name : "unknown"}`;
      if (row.attempts >= MAX_ATTEMPTS) {
        await store.finish(row.id, "dead", reason, now);
        out.dead++;
      } else {
        await store.finish(row.id, "retry", reason, now + retryDelayMs(row.attempts));
        out.retry++;
      }
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
        Omit<InboxRow, "next_attempt_at"> & { next_attempt_at: string }
      >;
      return (rows ?? []).map((r) => ({ ...r, next_attempt_at: Date.parse(r.next_attempt_at) }));
    },
    async finish(id, status, reason, next) {
      await rpc("youzan_asset_inbox_finish", {
        p_id: id, p_status: status, p_reason: reason, p_next_attempt_at: new Date(next).toISOString(),
      });
    },
  };
}
