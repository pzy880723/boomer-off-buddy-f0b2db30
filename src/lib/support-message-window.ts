/**
 * 客服详情消息窗口（纯逻辑）：limit / before / after 稳定游标 + 门店一致性校验 + 搜索词清洗。
 * 游标格式 "<created_at>|<uuid>"，与会话列表游标同构。
 */
import { decodeSupportCursor } from "@/lib/support-policy";

export const LEGACY_MESSAGE_WINDOW = 500;
export const MAX_MESSAGE_PAGE = 100;

export type MessageCursor = { created_at: string; id: string };
export type MessageWindow =
  | { mode: "latest"; limit: number; legacy: boolean }
  | { mode: "before"; limit: number; cursor: MessageCursor; raw: string }
  | { mode: "after"; limit: number; cursor: MessageCursor; raw: string };

export function encodeMessageCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}|${row.id}`;
}

export function parseMessageWindow(input: {
  limit?: string | number | null;
  before?: string | null;
  after?: string | null;
}): { ok: true; window: MessageWindow } | { ok: false; code: "invalid_cursor" | "cursor_conflict" | "invalid_limit" } {
  const before = input.before?.trim() || null;
  const after = input.after?.trim() || null;
  if (before && after) return { ok: false, code: "cursor_conflict" };
  const rawLimit = input.limit === null || input.limit === undefined || input.limit === "" ? null : Number(input.limit);
  if (rawLimit !== null && (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_MESSAGE_PAGE)) {
    return { ok: false, code: "invalid_limit" };
  }
  const raw = before ?? after;
  if (!raw) {
    // 旧客户端不传任何参数：保留最近 500 条
    return { ok: true, window: { mode: "latest", limit: rawLimit ?? LEGACY_MESSAGE_WINDOW, legacy: rawLimit === null } };
  }
  const c = decodeSupportCursor(raw);
  if (!c || c === "invalid") return { ok: false, code: "invalid_cursor" };
  const cursor = { created_at: c.updated_at, id: c.id };
  const limit = rawLimit ?? 50;
  return { ok: true, window: before ? { mode: "before", limit, cursor, raw } : { mode: "after", limit, cursor, raw } };
}

/** PostgREST or= 过滤：严格早于 / 晚于 (created_at, id) */
export function cursorFilter(mode: "before" | "after", c: MessageCursor): string {
  const op = mode === "before" ? "lt" : "gt";
  return `created_at.${op}."${c.created_at}",and(created_at.eq."${c.created_at}",id.${op}.${c.id})`;
}

/**
 * rows：latest/before 为倒序（新→旧）取 limit+1；after 为正序（旧→新）取 limit+1。
 * 输出永远正序。
 * - has_more：仅 latest/before 有意义，表示还有更早消息；after 固定 false。
 * - has_newer：仅 after 有意义，表示还有更新消息需继续排空；其它模式 false。
 * - older_cursor：本页最早一条；无结果时 before 回传请求游标，其它为 null。
 * - latest_cursor：本页最新一条（latest/after）；after 无结果回传请求游标；
 *   before（向上翻历史）固定 null，客户端不得用它覆盖增量水位。
 */
export function shapeMessageWindow<T extends { created_at: string; id: string }>(
  w: MessageWindow,
  rows: T[],
): { rows: T[]; has_more: boolean; has_newer: boolean; older_cursor: string | null; latest_cursor: string | null } {
  const extra = rows.length > w.limit;
  const page = rows.slice(0, w.limit);
  if (w.mode === "after") {
    const last = page.at(-1);
    const first = page[0];
    return {
      rows: page,
      has_more: false,
      has_newer: extra,
      older_cursor: first ? encodeMessageCursor(first) : null,
      latest_cursor: last ? encodeMessageCursor(last) : w.raw,
    };
  }
  const asc = [...page].reverse();
  const first = asc[0];
  const last = asc.at(-1);
  return {
    rows: asc,
    has_more: extra,
    has_newer: false,
    older_cursor: first ? encodeMessageCursor(first) : w.mode === "before" ? w.raw : null,
    latest_cursor: w.mode === "latest" && last ? encodeMessageCursor(last) : null,
  };
}

/** 可选 location_id：提供时必须等于会话门店（HQ 也不例外）。 */
export function assertConversationLocation(
  conversationLocationId: string | null,
  requested: string | null | undefined,
): { ok: true } | { ok: false; code: "location_mismatch" } {
  const wanted = requested?.trim() || null;
  if (!wanted) return { ok: true };
  return wanted === conversationLocationId ? { ok: true } : { ok: false, code: "location_mismatch" };
}

/** 列表搜索词：去首尾空白、<=80 字，去掉会破坏 PostgREST 过滤语法的字符。 */
export function sanitizeSupportSearch(q: string | null | undefined):
  | { ok: true; q: string | null }
  | { ok: false; code: "invalid_query" } {
  if (q === null || q === undefined) return { ok: true, q: null };
  const t = q.trim();
  if (t.length > 80) return { ok: false, code: "invalid_query" };
  const cleaned = t.replace(/[,()"'\\*%:]/g, " ").replace(/\s+/g, " ").trim();
  return { ok: true, q: cleaned || null };
}
