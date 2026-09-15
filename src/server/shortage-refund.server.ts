/**
 * 缺货售后（客户侧）读取与确认退款。依赖注入，便于纯测试。
 * 归属隔离：一律以服务端解析出的 customer_id 过滤，绝不接受客户端传入的 customer_id。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DERIVATIVE_WIDTHS, signDerivativeUrls } from "./media-derivative.server";
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
};

export type ConfirmOutcome =
  | { kind: "ok"; row: ShortageDbRow; replayed: boolean }
  | { kind: "quote_changed" }
  | { kind: "not_found" }
  | { kind: "not_confirmable"; message: string }
  | { kind: "error"; message: string };

export type ShortageDeps = {
  fetchOrders(customerId: string, orderId?: string): Promise<{ id: string; order_no: string | null }[]>;
  fetchShortages(orderIds: string[], shortageId?: string): Promise<ShortageDbRow[]>;
  fetchStoreNames(locationIds: string[]): Promise<Map<string, string>>;
  fetchIntentShortageIds(shortageIds: string[]): Promise<Set<string>>;
  signThumbnails(refs: string[]): Promise<(string | null)[]>;
  /** 旧缺货兼容：无报价时按订单实付重新核算并落库（无法安全报价则留人工）。 */
  ensureQuote(row: ShortageDbRow, customerId: string): Promise<ShortageDbRow>;
  confirmRefund(input: {
    shortageId: string;
    customerId: string;
    quoteVersion: string;
    idempotencyKey: string;
  }): Promise<ConfirmOutcome>;
};

async function buildCases(
  deps: ShortageDeps,
  inputRows: ShortageDbRow[],
  orderNoById: Map<string, string | null>,
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
  return rows.map((row, i) =>
    toShortageCase(row, {
      order_no: orderNoById.get(row.order_id ?? "") ?? null,
      store_name: row.location_id ? (stores.get(row.location_id) ?? null) : null,
      thumbnail_url: thumbs[i] ?? null,
      has_refund_intent: intents.has(row.id),
    }),
  );
}

export async function listShortageCases(
  deps: ShortageDeps,
  customerId: string,
  orderId?: string,
): Promise<ShortageCase[]> {
  const orders = await deps.fetchOrders(customerId, orderId);
  if (orders.length === 0) return [];
  const rows = await deps.fetchShortages(orders.map((o) => o.id));
  return buildCases(deps, rows, new Map(orders.map((o) => [o.id, o.order_no])), customerId);
}

/** 售后待办汇总：不依赖通知已读状态，旧缺货同样计入。 */
export async function getAfterSalesSummary(
  deps: ShortageDeps,
  customerId: string,
): Promise<{ pending_count: number; pending_shortage_count: number }> {
  const cases = await listShortageCases(deps, customerId);
  const pendingShortages = cases.filter((c) => c.status === "pending_customer").length;
  return { pending_count: pendingShortages, pending_shortage_count: pendingShortages };
}

export async function getShortageCase(
  deps: ShortageDeps,
  customerId: string,
  shortageId: string,
): Promise<ShortageCase | null> {
  const orders = await deps.fetchOrders(customerId);
  if (orders.length === 0) return null;
  const rows = await deps.fetchShortages(
    orders.map((o) => o.id),
    shortageId,
  );
  const cases = await buildCases(
    deps,
    rows,
    new Map(orders.map((o) => [o.id, o.order_no])),
    customerId,
  );
  return cases.find((c) => c.id === shortageId) ?? null;
}

export type ConfirmResult =
  | { status: 200; body: { ok: true; data: ShortageCase } }
  | { status: 404 | 409 | 422 | 500; body: { ok: false; error: string; code: string } };

export async function confirmShortageRefund(
  deps: ShortageDeps,
  input: { customerId: string; shortageId: string; quoteVersion: string },
): Promise<ConfirmResult> {
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
  "id, order_id, quantity, reason, status, refund_state, product_name, image_ref, location_id, quote_version, refund_goods_fen, refund_shipping_fen, refund_total_fen, created_at, customer_responded_at, refund_requested_at, refunded_at";

/** 生产依赖：内嵌 Supabase + 真实衍生图签名 + SECURITY DEFINER RPC。 */
export function createShortageDeps(): ShortageDeps {
  return {
    async fetchOrders(customerId, orderId) {
      let query = supabaseAdmin
        .from("commerce_orders" as never)
        .select("id, order_no")
        .eq("customer_id", customerId);
      if (orderId) query = query.eq("id", orderId);
      const { data } = await query.limit(200);
      return ((data as { id: string; order_no: string | null }[] | null) ?? []).map((row) => ({
        id: row.id,
        order_no: row.order_no ?? null,
      }));
    },
    async fetchShortages(orderIds, shortageId) {
      if (orderIds.length === 0) return [];
      let query = supabaseAdmin
        .from("fulfillment_shortages" as never)
        .select(SHORTAGE_COLUMNS)
        .in("order_id", orderIds);
      if (shortageId) query = query.eq("id", shortageId);
      const { data } = await query.order("created_at", { ascending: false }).limit(100);
      return (data as unknown as ShortageDbRow[] | null) ?? [];
    },
    async fetchStoreNames(locationIds) {
      const unique = [...new Set(locationIds)];
      if (unique.length === 0) return new Map();
      const { data } = await supabaseAdmin
        .from("inv_locations" as never)
        .select("id, name")
        .in("id", unique);
      return new Map(
        ((data as { id: string; name: string | null }[] | null) ?? []).map((row) => [
          row.id,
          row.name ?? "",
        ]),
      );
    },
    async fetchIntentShortageIds(shortageIds) {
      if (shortageIds.length === 0) return new Set();
      const { data } = await supabaseAdmin
        .from("commerce_refund_intents" as never)
        .select("shortage_id")
        .in("shortage_id", shortageIds);
      return new Set(
        ((data as { shortage_id: string }[] | null) ?? []).map((row) => row.shortage_id),
      );
    },
    async signThumbnails(refs) {
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
