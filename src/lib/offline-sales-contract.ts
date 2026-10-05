/**
 * 线下补录销售幂等合同（纯函数）。
 * 同门店同 client_op_id：载荷一致 → 回放；载荷不一致 → 409 冲突，绝不静默回放旧记录。
 */
export type OfflinePayload = {
  business_date: string;
  channel: string;
  amount_fen: number;
  order_count: number;
  evidence_type: string;
  evidence_ref: string | null;
  evidence_url: string | null;
  youzan_exclusion_basis: string;
  youzan_excluded_tids: string[];
  note: string | null;
};

export const OFFLINE_PAYLOAD_CONFLICT = "client_op_id_payload_conflict";

export class OfflineEntryConflictError extends Error {
  code = OFFLINE_PAYLOAD_CONFLICT;
  constructor(public fields: string[]) {
    super(`同一操作 ID 已用于不同内容：${fields.join(",")}`);
  }
}

const KEYS: (keyof OfflinePayload)[] = [
  "business_date", "channel", "amount_fen", "order_count", "evidence_type",
  "evidence_ref", "evidence_url", "youzan_exclusion_basis", "youzan_excluded_tids", "note",
];

function norm(k: keyof OfflinePayload, v: unknown): string {
  if (k === "youzan_excluded_tids") return JSON.stringify([...((v as string[] | null) ?? [])].sort());
  if (k === "amount_fen" || k === "order_count") return String(Number(v ?? 0));
  return v === undefined || v === null || v === "" ? "" : String(v);
}

/** 返回不一致的字段名；空数组 = 一致可回放。 */
export function diffOfflinePayload(existing: Partial<OfflinePayload>, incoming: OfflinePayload): string[] {
  return KEYS.filter((k) => norm(k, existing[k]) !== norm(k, incoming[k]));
}
