/**
 * 缺货报价事实读取（唯一 IO 入口）。ERP 新报缺货与旧单补报价共用。
 * 任何一项取数失败都抛错，绝不按 0 继续报价。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { QuoteFacts, ShortageSiblingRow } from "./facts";
import type { CourierSnapshot, OrderItemRow } from "./quote-input";
import type { IntentRowLite, RefundRowLite } from "./reserved";

export type OrderSnapshotRow = {
  id: string;
  customer_id: string | null;
  total_amount: number;
  shipping_fee: number;
  courier_quote_snapshot: CourierSnapshot;
};

export type ItemSnapshot = { title_snapshot: string | null; image_snapshot: string | null };

function unwrap<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}_read_failed: ${result.error.message}`);
  return result.data;
}

function toFen(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export async function loadOrderSnapshot(orderId: string): Promise<OrderSnapshotRow | null> {
  return unwrap(
    await supabaseAdmin
      .from("commerce_orders" as never)
      .select("id, customer_id, total_amount, shipping_fee, courier_quote_snapshot")
      .eq("id", orderId)
      .maybeSingle(),
    "order",
  ) as OrderSnapshotRow | null;
}

export async function loadQuoteFacts(
  order: OrderSnapshotRow,
): Promise<{ facts: QuoteFacts; snapshots: Map<string, ItemSnapshot> }> {
  const orderId = order.id;

  const itemRows =
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
          title_snapshot: string | null;
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

  const shortageRows =
    (unwrap(
      await supabaseAdmin
        .from("fulfillment_shortages" as never)
        .select(
          "id, order_item_id, location_id, quantity, status, refund_state, refund_intent_id, refund_shipping_fen",
        )
        .eq("order_id", orderId),
      "shortages",
    ) as ShortageSiblingRow[] | null) ?? [];

  const items: OrderItemRow[] = itemRows.map((r) => ({
    id: r.id,
    location_id: r.location_id,
    quantity: r.quantity,
    line_total: r.line_total,
  }));
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

  return {
    facts: {
      order: {
        total_amount: order.total_amount,
        shipping_fee: order.shipping_fee,
        courier_quote_snapshot: order.courier_quote_snapshot,
      },
      items,
      shippedLocationIds,
      refunds,
      intents,
      afterSaleItemById: new Map(afterSaleRows.map((a) => [a.id, a.order_item_id])),
      shortages: shortageRows,
    },
    snapshots: new Map(
      itemRows.map((r) => [
        r.id,
        { title_snapshot: r.title_snapshot ?? null, image_snapshot: r.image_snapshot ?? null },
      ]),
    ),
  };
}
