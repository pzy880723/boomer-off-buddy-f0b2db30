/**
 * 旧缺货兼容：为历史 fulfillment_shortages 行按现有订单实付快照**重新计算**真实报价，
 * 并在数据库事务内落库，使其可以被正常确认（走同一新事务）。
 *
 * 与 ERP 新报缺货共用 loadQuoteFacts + computeQuoteFromFacts，不存在第二套报价。
 *
 * 绝不编造金额：无法安全报价（can_confirm=false）时落 manual_review + 金额 0 + 无 quote_version。
 *
 * 失效重算：只要仍是 pending_customer 且尚无退款意图，就按当前事实重算。
 * 发货等事实变化会让旧的含运费报价被安全地改写成 goods-only 新版本，
 * 客户重新确认新版本即可，不会永久卡在 409 QUOTE_CHANGED。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { computeQuoteFromFacts } from "@/lib/shortage-refund/facts";
import { loadOrderSnapshot, loadQuoteFacts } from "@/lib/shortage-refund/facts.server";
import type { ShortageDbRow } from "./shortage-refund.server";

/** 仍可被改写报价的行：客户尚未表态、且没有退款意图。 */
export function needsQuote(row: ShortageDbRow): boolean {
  if (row.status !== "pending_customer") return false;
  if (row.refund_intent_id) return false;
  return true;
}

/** 重算结果与已存报价是否一致（一致则不写库，避免无谓的版本抖动）。 */
export function quoteMatchesRow(
  row: ShortageDbRow,
  quote: { quote_version: string; refund_total_fen: number; refund_goods_fen: number; refund_shipping_fen: number; can_confirm: boolean },
): boolean {
  if (!quote.can_confirm) {
    return row.quote_version === null && (row.refund_total_fen ?? 0) === 0 && row.refund_state === "manual_review";
  }
  return (
    row.quote_version === quote.quote_version &&
    (row.refund_total_fen ?? 0) === quote.refund_total_fen &&
    (row.refund_goods_fen ?? 0) === quote.refund_goods_fen &&
    (row.refund_shipping_fen ?? 0) === quote.refund_shipping_fen &&
    row.refund_state === "awaiting_confirmation"
  );
}

function unwrap<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}_read_failed: ${result.error.message}`);
  return result.data;
}

export async function ensureShortageQuote(
  row: ShortageDbRow,
  customerId: string,
): Promise<ShortageDbRow> {
  if (!needsQuote(row)) return row;

  const item = unwrap(
    await supabaseAdmin
      .from("fulfillment_items" as never)
      .select("id, order_item_id, fulfillment_id")
      .eq("id", row.fulfillment_item_id ?? "")
      .maybeSingle(),
    "fulfillment_item",
  ) as { order_item_id: string | null; fulfillment_id: string } | null;

  const fRow = unwrap(
    await supabaseAdmin
      .from("fulfillments" as never)
      .select("id, order_id, location_id")
      .eq("id", item?.fulfillment_id ?? "")
      .maybeSingle(),
    "fulfillment",
  ) as { order_id: string; location_id: string | null } | null;

  const orderId = row.order_id ?? fRow?.order_id ?? "";
  const orderItemId = row.order_item_id ?? item?.order_item_id ?? "";

  const orderRow = await loadOrderSnapshot(orderId);
  // 归属隔离：非本人订单直接返回原行，不写任何东西。
  if (!orderRow || orderRow.customer_id !== customerId) return row;

  const { facts, snapshots } = await loadQuoteFacts(orderRow);
  const locationId = row.location_id ?? fRow?.location_id ?? null;
  const quote = computeQuoteFromFacts(facts, {
    shortageId: row.id,
    orderItemId,
    locationId,
    quantity: row.quantity,
  });

  if (quoteMatchesRow(row, quote)) return row;

  const snapshot = snapshots.get(orderItemId);
  const { data: updated, error } = await supabaseAdmin.rpc("shortage_attach_quote_v1" as never, {
    p_shortage_id: row.id,
    p_customer_id: customerId,
    p_order_item_id: orderItemId || null,
    p_location_id: locationId,
    p_quote: {
      ...quote,
      product_name: snapshot?.title_snapshot ?? null,
      image_ref: snapshot?.image_snapshot ?? null,
    },
  } as never);
  if (error) throw new Error(`shortage_attach_quote_failed: ${error.message}`);
  const payload = updated as { shortage?: ShortageDbRow } | null;
  return payload?.shortage ? { ...row, ...payload.shortage } : row;
}
