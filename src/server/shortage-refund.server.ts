/**
 * 缺货售后（客户侧）读取与确认退款。依赖注入，便于纯测试。
 *
 * 归属隔离：一律以服务端解析出的 customer_id 过滤（数据库层 inner join order.customer_id），
 * 绝不接受客户端传入的 customer_id，也不再靠「扫描最近若干订单」来判断归属。
 *
 * 安全关键读取失败一律抛错，绝不把错误当成「没有缺货 / 没有退款 / 计数 0」。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DERIVATIVE_WIDTHS, signDerivativeUrls } from "./media-derivative.server";
import { ensureShortageQuote } from "./shortage-quote.server";
import { refundWorkerEnabled } from "./shortage-refund-runtime.server";
import {
  confirmIdempotencyKey,
  toShortageCase,
  type ShortageCase,
  type ShortageRow,
} from "@/lib/shortage-refund/case";

export type ShortageDbRow = ShortageRow & {
  image_ref: string | null;
  location_id: string | null;
  order_item_id: string | null;
  fulfillment_item_id: string | null;
  refund_intent_id: string | null;
  /** 由订单内联查询带出，避免为了拿单号去扫描订单表。 */
  order_no: string | null;
};

export type ConfirmOutcome =
  | { kind: "ok"; row: ShortageDbRow; replayed: boolean }
  | { kind: "quote_changed" }
  | { kind: "not_found" }
  | { kind: "not_confirmable"; message: string }
  | { kind: "error"; message: string };

export type ShortagePage = { rows: ShortageDbRow[]; nextCursor: string | null };

export type ShortageDeps = {
  /** 按 customer 完整分页读取缺货（服务端归属过滤）。取数失败必须抛错。 */
  fetchShortagePage(
    customerId: string,
    opts: { orderId?: string; cursor: string | null; pageSize: number },
  ): Promise<ShortagePage>;
  /** 详情：直接用 shortage id + order.customer_id 归属，不扫描订单。 */
  fetchShortageById(customerId: string, shortageId: string): Promise<ShortageDbRow | null>;
  /** 纯计数：不补报价、不签图。 */
  countPendingShortages(customerId: string): Promise<number>;
  fetchStoreNames(locationIds: string[]): Promise<Map<string, string>>;
  fetchIntentShortageIds(shortageIds: string[]): Promise<Set<string>>;
  signThumbnails(refs: string[]): Promise<(string | null)[]>;
  /** 旧缺货兼容：无报价时按订单实付重新核算并落库（无法安全报价则留人工）。 */
  ensureQuote(row: ShortageDbRow, customerId: string): Promise<ShortageDbRow>;
  /** 真实退款执行是否已开启；关闭时 can_confirm=false 并给出原因，且不接受确认写入。 */
  refundExecutionEnabled(): boolean;
  confirmRefund(input: {
    shortageId: string;
    customerId: string;
    quoteVersion: string;
    idempotencyKey: string;
  }): Promise<ConfirmOutcome>;
};

/** 键集游标编码：`<created_at>|<id>`。 */
export function formatShortageCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}|${row.id}`;
}

export function parseShortageCursor(
  cursor: string | null,
): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const idx = cursor.lastIndexOf("|");
  if (idx <= 0) return null;
  const createdAt = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

export const SHORTAGE_PAGE_SIZE = 200;
export const SHORTAGE_MAX_PAGES = 100;

async function buildCases(
  deps: ShortageDeps,
  inputRows: ShortageDbRow[],
  customerId: string,
): Promise<ShortageCase[]> {
  if (inputRows.length === 0) return [];
  // 旧缺货：读时补真实报价（无法安全报价则转人工），使其成为可确认的待办。
  const rows: ShortageDbRow[] = [];
  for (const row of inputRows) rows.push(await deps.ensureQuote(row, customerId));
  const [stores, intents, thumbs] = await Promise.all([
    deps.fetchStoreNames(rows.map((r) => r.location_id).filter((v): v is string => !!v)),
    deps.fetchIntentShortageIds(rows.map((r) => r.id)),
    deps.signThumbnails(rows.map((r) => r.image_ref ?? "")),
  ]);
  const refundsEnabled = deps.refundExecutionEnabled();
  return rows.map((row, i) =>
    toShortageCase(row, {
      order_no: row.order_no,
      store_name: row.location_id ? (stores.get(row.location_id) ?? null) : null,
      thumbnail_url: thumbs[i] ?? null,
      has_refund_intent: intents.has(row.id),
      refund_execution_enabled: refundsEnabled,
    }),
  );
}

/** 读取本人全部缺货（完整分页，绝不静默截断）。 */
export async function fetchAllShortageRows(
  deps: ShortageDeps,
  customerId: string,
  orderId?: string,
): Promise<ShortageDbRow[]> {
  const rows: ShortageDbRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < SHORTAGE_MAX_PAGES; page++) {
    const result: ShortagePage = await deps.fetchShortagePage(customerId, {
      orderId,
      cursor,
      pageSize: SHORTAGE_PAGE_SIZE,
    });
    rows.push(...result.rows);
    if (!result.nextCursor) return rows;
    cursor = result.nextCursor;
  }
  throw new Error("shortage_pagination_overflow");
}

export async function listShortageCases(
  deps: ShortageDeps,
  customerId: string,
  orderId?: string,
): Promise<ShortageCase[]> {
  const rows = await fetchAllShortageRows(deps, customerId, orderId);
  return buildCases(deps, rows, customerId);
}

/**
 * 售后待办汇总：纯计数。
 * 不补报价、不签图、不构造 DTO；不依赖通知已读状态，旧缺货同样计入。
 */
export async function getAfterSalesSummary(
  deps: ShortageDeps,
  customerId: string,
): Promise<{ pending_count: number; pending_shortage_count: number }> {
  const pending = await deps.countPendingShortages(customerId);
  const count = Math.max(0, Math.trunc(pending));
  return { pending_count: count, pending_shortage_count: count };
}

export async function getShortageCase(
  deps: ShortageDeps,
  customerId: string,
  shortageId: string,
): Promise<ShortageCase | null> {
  const row = await deps.fetchShortageById(customerId, shortageId);
  if (!row) return null;
  const cases = await buildCases(deps, [row], customerId);
  return cases[0] ?? null;
}

export type ConfirmResult =
  | { status: 200; body: { ok: true; data: ShortageCase } }
  | { status: 404 | 409 | 422 | 500 | 503; body: { ok: false; error: string; code: string } };

export const REFUND_DISABLED_BODY = {
  ok: false as const,
  error: "退款执行未开启，请稍后再试",
  code: "refund_worker_disabled",
};

export async function confirmShortageRefund(
  deps: ShortageDeps,
  input: { customerId: string; shortageId: string; quoteVersion: string },
): Promise<ConfirmResult> {
  // 未开启真实退款执行时，在任何确认写入之前就明确拒绝（不入队、不伪装成功）。
  if (!deps.refundExecutionEnabled()) {
    return { status: 503, body: REFUND_DISABLED_BODY };
  }
  const outcome = await deps.confirmRefund({
    shortageId: input.shortageId,
    customerId: input.customerId,
    quoteVersion: input.quoteVersion,
    idempotencyKey: confirmIdempotencyKey(input.shortageId, input.quoteVersion),
  });
  if (outcome.kind === "quote_changed") {
    return { status: 409, body: { ok: false, error: "Quote changed", code: "QUOTE_CHANGED" } };
  }
  if (outcome.kind === "not_found") {
    return { status: 404, body: { ok: false, error: "Shortage not found", code: "not_found" } };
  }
  if (outcome.kind === "not_confirmable") {
    return { status: 422, body: { ok: false, error: outcome.message, code: "not_confirmable" } };
  }
  if (outcome.kind === "error") {
    return { status: 500, body: { ok: false, error: outcome.message, code: "internal_error" } };
  }
  const fresh = await getShortageCase(deps, input.customerId, input.shortageId);
  if (!fresh) {
    return { status: 404, body: { ok: false, error: "Shortage not found", code: "not_found" } };
  }
  return { status: 200, body: { ok: true, data: fresh } };
}

const SHORTAGE_COLUMNS =
  "id, order_id, order_item_id, fulfillment_item_id, refund_intent_id, quantity, reason, status, refund_state, product_name, image_ref, location_id, quote_version, refund_goods_fen, refund_shipping_fen, refund_total_fen, created_at, customer_responded_at, refund_requested_at, refunded_at, order:commerce_orders!inner(id, order_no, customer_id)";

type RawShortage = Omit<ShortageDbRow, "order_no"> & {
  order?: { id: string; order_no: string | null; customer_id: string } | null;
};

function mapRows(data: unknown): ShortageDbRow[] {
  return ((data as RawShortage[] | null) ?? []).map((row) => {
    const { order, ...rest } = row;
    return { ...rest, order_no: order?.order_no ?? null } as ShortageDbRow;
  });
}

/** 生产依赖：内嵌 Supabase + 真实衍生图签名 + SECURITY DEFINER RPC。 */
export function createShortageDeps(): ShortageDeps {
  return {
    ensureQuote: (row, customerId) => ensureShortageQuote(row, customerId),
    refundExecutionEnabled: () => refundWorkerEnabled(),
    async fetchShortagePage(customerId, { orderId, cursor, pageSize }) {
      let query = supabaseAdmin
        .from("fulfillment_shortages" as never)
        .select(SHORTAGE_COLUMNS)
        .eq("order.customer_id", customerId);
      if (orderId) query = query.eq("order_id", orderId);
      // 键集游标 (created_at, id)：同一时间戳的多行不会被漏掉。
      const parsed = parseShortageCursor(cursor);
      if (parsed) {
        query = query.or(
          `created_at.lt.${parsed.createdAt},and(created_at.eq.${parsed.createdAt},id.lt.${parsed.id})`,
        );
      }
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(pageSize);
      if (error) throw new Error(`shortage_read_failed: ${error.message}`);
      const rows = mapRows(data);
      const last = rows[rows.length - 1];
      const next = rows.length >= pageSize && last ? formatShortageCursor(last) : null;
      return { rows, nextCursor: next };
    },
    async fetchShortageById(customerId, shortageId) {
      const { data, error } = await supabaseAdmin
        .from("fulfillment_shortages" as never)
        .select(SHORTAGE_COLUMNS)
        .eq("id", shortageId)
        .eq("order.customer_id", customerId)
        .limit(1);
      if (error) throw new Error(`shortage_read_failed: ${error.message}`);
      return mapRows(data)[0] ?? null;
    },
    async countPendingShortages(customerId) {
      const { count, error } = await supabaseAdmin
        .from("fulfillment_shortages" as never)
        .select("id, order:commerce_orders!inner(customer_id)", { count: "exact", head: true })
        .eq("order.customer_id", customerId)
        .eq("status", "pending_customer");
      if (error) throw new Error(`shortage_count_failed: ${error.message}`);
      return count ?? 0;
    },
    async fetchStoreNames(locationIds) {
      const unique = [...new Set(locationIds)];
      if (unique.length === 0) return new Map();
      const { data, error } = await supabaseAdmin
        .from("inv_locations" as never)
        .select("id, name")
        .in("id", unique);
      if (error) throw new Error(`location_read_failed: ${error.message}`);
      return new Map(
        ((data as { id: string; name: string | null }[] | null) ?? []).map((row) => [
          row.id,
          row.name ?? "",
        ]),
      );
    },
    async fetchIntentShortageIds(shortageIds) {
      if (shortageIds.length === 0) return new Set();
      const { data, error } = await supabaseAdmin
        .from("commerce_refund_intents" as never)
        .select("shortage_id")
        .in("shortage_id", shortageIds);
      // 退款意图读取失败绝不能当成「没有退款」，否则会放行二次退款。
      if (error) throw new Error(`refund_intent_read_failed: ${error.message}`);
      return new Set(
        ((data as { shortage_id: string }[] | null) ?? []).map((row) => row.shortage_id),
      );
    },
    async signThumbnails(refs) {
      // 图片非安全关键：失败一律 null，绝不回退原图。
      try {
        return await signDerivativeUrls(refs, DERIVATIVE_WIDTHS.thumbnail);
      } catch {
        return refs.map(() => null);
      }
    },
    async confirmRefund({ shortageId, customerId, quoteVersion, idempotencyKey }) {
      const { data, error } = await supabaseAdmin.rpc("shortage_confirm_refund_v1" as never, {
        p_shortage_id: shortageId,
        p_customer_id: customerId,
        p_quote_version: quoteVersion,
        p_idempotency_key: idempotencyKey,
      } as never);
      if (error) {
        const message = error.message ?? "";
        if (message.includes("QUOTE_CHANGED")) return { kind: "quote_changed" };
        if (message.includes("not_found")) return { kind: "not_found" };
        if (message.includes("not_confirmable") || message.includes("no_refundable_amount")) {
          return { kind: "not_confirmable", message };
        }
        return { kind: "error", message };
      }
      const payload = data as { shortage?: ShortageDbRow; replayed?: boolean } | null;
      return {
        kind: "ok",
        row: (payload?.shortage ?? null) as ShortageDbRow,
        replayed: payload?.replayed === true,
      };
    },
  };
}
