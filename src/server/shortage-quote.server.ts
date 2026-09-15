/**
 * 旧缺货兼容：为历史 fulfillment_shortages 行按现有订单实付快照重新计算真实报价，
 * 并在数据库事务内落库，使其可以在客户端被正常确认（走同一新事务）。
 *
 * 绝不编造金额：无法安全报价时写 manual_review + 金额 0 + 无 quote_version，
 * 客户端据此显示「人工处理」，can_confirm=false。
 *
 * 金额铁律：
 * - 已退 + 预占按 refund_id / after_sale_id 关联去重，同一笔只占一次。
 * - 商品级上限用该行自身已退 + 预占（不是写死 0）。
 * - 同组其余行的待履约数量要扣掉已确认缺货 / 已退的数量。
 * - 任何一项取数失败都抛错，不得按 0 继续报价。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { computeShortageQuote } from "@/lib/shortage-refund/quote";
import { buildQuoteInput, type CourierSnapshot } from "@/lib/shortage-refund/quote-input";
import {
  computeReservedFen,
  groupOutstandingQuantity,
  type IntentRowLite,
  type RefundRowLite,
} from "@/lib/shortage-refund/reserved";
import type { ShortageDbRow } from "./shortage-refund.server";

/** 仅这些行需要补报价：客户仍待处理、尚无退款意图、且没有有效报价版本。 */
export function needsQuote(row: ShortageDbRow): boolean {
  if (row.status !== "pending_customer") return false;
  if (row.refund_intent_id) return false;
  return !row.quote_version || !row.refund_total_fen;
}

function unwrap<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}_read_failed: ${result.error.message}`);
  return result.data;
}

function toFen(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
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

  const orderRow = unwrap(
    await supabaseAdmin
      .from("commerce_orders" as never)
      .select("id, customer_id, total_amount, shipping_fee, courier_quote_snapshot")
      .eq("id", orderId)
      .maybeSingle(),
    "order",
  ) as
    | {
        customer_id: string | null;
        total_amount: number;
        shipping_fee: number;
        courier_quote_snapshot: CourierSnapshot;
      }
    | null;
  // 归属隔离：非本人订单直接返回原行，不写任何东西。
  if (!orderRow || orderRow.customer_id !== customerId) return row;

  const orderItemRows =
    (unwrap(
      await supabaseAdmin
        .from("commerce_order_items" as never)
        .select("id, location_id, quantity, line_total, title_snapshot, image_snapshot")
        .eq("order_id", orderId),
      "order_items",
    ) as
      | {
          id: string;
          location_id: string | null;
          quantity: number;
          line_total: number;
          title_snapshot: string;
          image_snapshot: string | null;
        }[]
      | null) ?? [];

  const fulfillmentRows =
    (unwrap(
      await supabaseAdmin
        .from("fulfillments" as never)
        .select("location_id, shipments(id)")
        .eq("order_id", orderId),
      "fulfillments",
    ) as { location_id: string | null; shipments: { id: string }[] }[] | null) ?? [];
  const shippedLocationIds = new Set<string>();
  for (const f of fulfillmentRows) {
    if (f.location_id && f.shipments?.length) shippedLocationIds.add(f.location_id);
  }

  // 已退 + 预占：refunds 与 intents 通过 after_sale_id / refund_id 去重，同一笔只算一次。
  const refundRows =
    (unwrap(
      await supabaseAdmin
        .from("commerce_refunds" as never)
        .select("id, after_sale_id, amount, status")
        .eq("order_id", orderId),
      "refunds",
    ) as { id: string; after_sale_id: string | null; amount: number; status: string }[] | null) ??
    [];
  const intentRows =
    (unwrap(
      await supabaseAdmin
        .from("commerce_refund_intents" as never)
        .select("id, after_sale_id, refund_id, amount_fen, state")
        .eq("order_id", orderId),
      "refund_intents",
    ) as
      | {
          id: string;
          after_sale_id: string | null;
          refund_id: string | null;
          amount_fen: number;
          state: string;
        }[]
      | null) ?? [];
  const afterSaleRows =
    (unwrap(
      await supabaseAdmin
        .from("commerce_after_sales" as never)
        .select("id, order_item_id")
        .eq("order_id", orderId),
      "after_sales",
    ) as { id: string; order_item_id: string | null }[] | null) ?? [];
  const itemByAfterSale = new Map(afterSaleRows.map((a) => [a.id, a.order_item_id]));

  const refunds: RefundRowLite[] = refundRows.map((r) => ({
    id: r.id,
    after_sale_id: r.after_sale_id,
    status: r.status,
    amount_fen: toFen(r.amount),
  }));
  const intents: IntentRowLite[] = intentRows.map((i) => ({
    id: i.id,
    after_sale_id: i.after_sale_id,
    refund_id: i.refund_id,
    state: i.state,
    amount_fen: i.amount_fen,
  }));

  const paymentRefundedFen = computeReservedFen(refunds, intents);
  const belongsToItem = (afterSaleId: string | null, itemId: string) =>
    !!afterSaleId && itemByAfterSale.get(afterSaleId) === itemId;
  const itemRefundedFen = computeReservedFen(
    refunds.filter((r) => belongsToItem(r.after_sale_id, orderItemId)),
    intents.filter((i) => belongsToItem(i.after_sale_id, orderItemId)),
  );

  // 同组其余行的待履约数量：扣掉已确认缺货（非 pending / 已进入退款）的数量。
  const settledRows =
    (unwrap(
      await supabaseAdmin
        .from("fulfillment_shortages" as never)
        .select("id, order_item_id, quantity, status")
        .eq("order_id", orderId),
      "shortages",
    ) as { id: string; order_item_id: string | null; quantity: number; status: string }[] | null) ??
    [];
  const settledQuantityByItem = new Map<string, number>();
  for (const s of settledRows) {
    if (!s.order_item_id || s.id === row.id) continue;
    settledQuantityByItem.set(
      s.order_item_id,
      (settledQuantityByItem.get(s.order_item_id) ?? 0) + Math.max(0, s.quantity),
    );
  }

  const locationId = row.location_id ?? fRow?.location_id ?? null;
  const snapshot = orderItemRows.find((r) => r.id === orderItemId);
  const groupOutstanding = groupOutstandingQuantity({
    items: orderItemRows,
    locationId,
    excludeOrderItemId: orderItemId,
    settledQuantityByItem,
  });

  const quote = computeShortageQuote(
    buildQuoteInput({
      order: orderRow,
      items: orderItemRows,
      shortage: { order_item_id: orderItemId, quantity: row.quantity },
      shippedLocationIds,
      itemRefundedFen,
      paymentRefundedFen,
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
  if (error) throw new Error(`shortage_attach_quote_failed: ${error.message}`);
  const payload = updated as { shortage?: ShortageDbRow } | null;
  return payload?.shortage ? { ...row, ...payload.shortage } : row;
}
