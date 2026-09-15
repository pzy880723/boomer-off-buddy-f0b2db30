/**
 * 旧缺货兼容：为历史 fulfillment_shortages 行按现有订单实付快照重新计算真实报价，
 * 并在数据库事务内落库，使其可以在客户端被正常确认（走同一新事务）。
 *
 * 绝不编造金额：无法安全报价时写 manual_review + 金额 0 + 无 quote_version，
 * 客户端据此显示「人工处理」，can_confirm=false。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { computeShortageQuote } from "@/lib/shortage-refund/quote";
import { buildQuoteInput, type CourierSnapshot } from "@/lib/shortage-refund/quote-input";
import type { ShortageDbRow } from "./shortage-refund.server";

/** 仅这些行需要补报价：客户仍待处理、尚无退款意图、且没有有效报价版本。 */
export function needsQuote(row: ShortageDbRow): boolean {
  if (row.status !== "pending_customer") return false;
  if (row.refund_intent_id) return false;
  return !row.quote_version || !row.refund_total_fen;
}

export async function ensureShortageQuote(
  row: ShortageDbRow,
  customerId: string,
): Promise<ShortageDbRow> {
  if (!needsQuote(row)) return row;

  const { data: item } = await supabaseAdmin
    .from("fulfillment_items" as never)
    .select("id, order_item_id, fulfillment_id")
    .eq("id", row.fulfillment_item_id ?? "")
    .maybeSingle();
  const itemRow = item as { order_item_id: string | null; fulfillment_id: string } | null;

  const { data: fulfillment } = await supabaseAdmin
    .from("fulfillments" as never)
    .select("id, order_id, location_id")
    .eq("id", itemRow?.fulfillment_id ?? "")
    .maybeSingle();
  const fRow = fulfillment as { order_id: string; location_id: string | null } | null;

  const orderId = row.order_id ?? fRow?.order_id ?? "";
  const orderItemId = row.order_item_id ?? itemRow?.order_item_id ?? "";

  const { data: order } = await supabaseAdmin
    .from("commerce_orders" as never)
    .select("id, customer_id, total_amount, shipping_fee, courier_quote_snapshot")
    .eq("id", orderId)
    .maybeSingle();
  const orderRow = order as
    | {
        customer_id: string | null;
        total_amount: number;
        shipping_fee: number;
        courier_quote_snapshot: CourierSnapshot;
      }
    | null;
  // 归属隔离：非本人订单直接返回原行，不写任何东西。
  if (!orderRow || orderRow.customer_id !== customerId) return row;

  const { data: orderItems } = await supabaseAdmin
    .from("commerce_order_items" as never)
    .select("id, location_id, quantity, line_total, title_snapshot, image_snapshot")
    .eq("order_id", orderId);
  const orderItemRows =
    (orderItems as
      | {
          id: string;
          location_id: string | null;
          quantity: number;
          line_total: number;
          title_snapshot: string;
          image_snapshot: string | null;
        }[]
      | null) ?? [];

  const { data: fulfillments } = await supabaseAdmin
    .from("fulfillments" as never)
    .select("location_id, shipments(id)")
    .eq("order_id", orderId);
  const shippedLocationIds = new Set<string>();
  for (const f of ((fulfillments as { location_id: string | null; shipments: { id: string }[] }[] | null) ?? [])) {
    if (f.location_id && f.shipments?.length) shippedLocationIds.add(f.location_id);
  }

  const { data: refunds } = await supabaseAdmin
    .from("commerce_refunds" as never)
    .select("amount, status")
    .eq("order_id", orderId);
  const paymentRefundedFen = ((refunds as { amount: number; status: string }[] | null) ?? [])
    .filter((r) => ["pending", "processing", "succeeded"].includes(r.status))
    .reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0);

  const { data: intents } = await supabaseAdmin
    .from("commerce_refund_intents" as never)
    .select("amount_fen, state")
    .eq("order_id", orderId);
  const intentFen = ((intents as { amount_fen: number; state: string }[] | null) ?? [])
    .filter((r) => r.state !== "failed")
    .reduce((sum, r) => sum + r.amount_fen, 0);

  const locationId = row.location_id ?? fRow?.location_id ?? null;
  const snapshot = orderItemRows.find((r) => r.id === orderItemId);
  const groupOutstanding = orderItemRows
    .filter((r) => r.location_id === locationId && r.id !== orderItemId)
    .reduce((sum, r) => sum + r.quantity, 0);

  const quote = computeShortageQuote(
    buildQuoteInput({
      order: orderRow,
      items: orderItemRows,
      shortage: { order_item_id: orderItemId, quantity: row.quantity },
      shippedLocationIds,
      itemRefundedFen: 0,
      paymentRefundedFen: paymentRefundedFen + intentFen,
      groupOutstandingQuantity: groupOutstanding,
    }),
  );

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
  if (error) return row;
  const payload = updated as { shortage?: ShortageDbRow } | null;
  return payload?.shortage ?? row;
}
