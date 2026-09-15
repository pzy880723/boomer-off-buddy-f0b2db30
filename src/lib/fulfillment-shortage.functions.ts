/**
 * ERP 侧：网店订单门店子单详情、手工发货（快递公司 + 单号 + 本次数量）、缺货申报。
 * 手工发货不依赖电子面单；缺货申报走 SECURITY DEFINER RPC，原子锁定可申报数量。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildQuoteInput, type CourierSnapshot } from "@/lib/shortage-refund/quote-input";
import { computeShortageQuote } from "@/lib/shortage-refund/quote";

export type StoreSubOrderItem = {
  fulfillment_item_id: string;
  order_item_id: string | null;
  title: string;
  image_snapshot: string | null;
  expected_qty: number;
  picked_qty: number;
  declared_shortage_qty: number;
  declarable_qty: number;
};

export type StoreSubOrder = {
  fulfillment_id: string;
  code: string;
  status: string;
  location_id: string | null;
  store_name: string | null;
  tracking_no: string | null;
  provider: string | null;
  items: StoreSubOrderItem[];
};

export const getOrderStoreSubOrders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ orderId: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<{ order_no: string | null; shops: StoreSubOrder[] }> => {
    const { data: order } = await supabaseAdmin
      .from("commerce_orders" as never)
      .select("id, order_no")
      .eq("id", data.orderId)
      .maybeSingle();
    if (!order) throw new Error("订单不存在");

    const { data: fulfillments } = await supabaseAdmin
      .from("fulfillments" as never)
      .select(
        "id, code, status, location_id, location:inv_locations!location_id(name), items:fulfillment_items(id, order_item_id, expected_qty, picked_qty), shipments(provider, tracking_no, created_at)",
      )
      .eq("order_id", data.orderId);

    const rows = (fulfillments ?? []) as unknown as Array<{
      id: string;
      code: string;
      status: string;
      location_id: string | null;
      location: { name: string } | null;
      items: Array<{ id: string; order_item_id: string | null; expected_qty: number; picked_qty: number }>;
      shipments: Array<{ provider: string | null; tracking_no: string | null; created_at: string }>;
    }>;

    const orderItemIds = rows.flatMap((row) => row.items.map((i) => i.order_item_id).filter(Boolean)) as string[];
    const { data: orderItems } = orderItemIds.length
      ? await supabaseAdmin
          .from("commerce_order_items" as never)
          .select("id, title_snapshot, image_snapshot")
          .in("id", orderItemIds)
      : { data: [] };
    const titleById = new Map(
      ((orderItems as { id: string; title_snapshot: string; image_snapshot: string | null }[] | null) ?? []).map(
        (row) => [row.id, row],
      ),
    );

    const fulfillmentItemIds = rows.flatMap((row) => row.items.map((i) => i.id));
    const { data: shortages } = fulfillmentItemIds.length
      ? await supabaseAdmin
          .from("fulfillment_shortages" as never)
          .select("fulfillment_item_id, quantity, status")
          .in("fulfillment_item_id", fulfillmentItemIds)
      : { data: [] };
    const declared = new Map<string, number>();
    for (const row of ((shortages as { fulfillment_item_id: string; quantity: number; status: string }[] | null) ??
      [])) {
      if (row.status === "withdrawn") continue;
      declared.set(row.fulfillment_item_id, (declared.get(row.fulfillment_item_id) ?? 0) + row.quantity);
    }

    return {
      order_no: (order as { order_no: string | null }).order_no ?? null,
      shops: rows.map((row) => {
        const shipment = [...row.shipments].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
        return {
          fulfillment_id: row.id,
          code: row.code,
          status: row.status,
          location_id: row.location_id,
          store_name: row.location?.name ?? null,
          tracking_no: shipment?.tracking_no ?? null,
          provider: shipment?.provider ?? null,
          items: row.items.map((item) => {
            const declaredQty = declared.get(item.id) ?? 0;
            const snapshot = item.order_item_id ? titleById.get(item.order_item_id) : undefined;
            return {
              fulfillment_item_id: item.id,
              order_item_id: item.order_item_id,
              title: snapshot?.title_snapshot ?? "商品",
              image_snapshot: snapshot?.image_snapshot ?? null,
              expected_qty: item.expected_qty ?? 0,
              picked_qty: item.picked_qty ?? 0,
              declared_shortage_qty: declaredQty,
              declarable_qty: Math.max(0, (item.expected_qty ?? 0) - (item.picked_qty ?? 0) - declaredQty),
            };
          }),
        };
      }),
    };
  });

export const manualShipStoreSubOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        fulfillmentId: z.string().uuid(),
        provider: z.string().trim().min(1).max(60),
        trackingNo: z.string().trim().min(4).max(64),
        clientOpId: z.string().trim().min(6).max(80),
        lines: z
          .array(z.object({ fulfillmentItemId: z.string().uuid(), quantity: z.number().int().min(1) }))
          .min(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { data: existing } = await supabaseAdmin
      .from("shipments" as never)
      .select("id, provider, tracking_no")
      .eq("idempotency_key", data.clientOpId)
      .maybeSingle();
    if (existing) return { ok: true as const, replayed: true, shipment: existing };

    const { data: items } = await supabaseAdmin
      .from("fulfillment_items" as never)
      .select("id, expected_qty, picked_qty")
      .eq("fulfillment_id", data.fulfillmentId);
    const byId = new Map(
      ((items as { id: string; expected_qty: number; picked_qty: number }[] | null) ?? []).map((row) => [row.id, row]),
    );
    for (const line of data.lines) {
      const row = byId.get(line.fulfillmentItemId);
      if (!row) throw new Error("发货明细与子单不符");
      if (line.quantity > (row.expected_qty ?? 0) - (row.picked_qty ?? 0)) {
        throw new Error("本次发货数量超过待发数量");
      }
    }

    const { data: shipment, error } = await supabaseAdmin
      .from("shipments" as never)
      .insert({
        fulfillment_id: data.fulfillmentId,
        provider: data.provider,
        status: "booked",
        tracking_no: data.trackingNo,
        idempotency_key: data.clientOpId,
        booked_at: new Date().toISOString(),
      } as never)
      .select("id, provider, tracking_no")
      .single();
    if (error) throw new Error(error.message);

    for (const line of data.lines) {
      const row = byId.get(line.fulfillmentItemId)!;
      await supabaseAdmin
        .from("fulfillment_items" as never)
        .update({ picked_qty: (row.picked_qty ?? 0) + line.quantity, picked_at: new Date().toISOString() } as never)
        .eq("id", line.fulfillmentItemId);
    }
    await supabaseAdmin
      .from("fulfillments" as never)
      .update({ status: "handed_over", handed_over_at: new Date().toISOString() } as never)
      .eq("id", data.fulfillmentId);

    return { ok: true as const, replayed: false, shipment };
  });

export const reportStoreShortage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        fulfillmentId: z.string().uuid(),
        fulfillmentItemId: z.string().uuid(),
        quantity: z.number().int().min(1),
        reason: z.string().trim().min(1).max(200),
        clientOpId: z.string().trim().min(6).max(80),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: item } = await supabaseAdmin
      .from("fulfillment_items" as never)
      .select("id, order_item_id, fulfillment_id")
      .eq("id", data.fulfillmentItemId)
      .maybeSingle();
    const itemRow = item as { id: string; order_item_id: string | null; fulfillment_id: string } | null;
    if (!itemRow || itemRow.fulfillment_id !== data.fulfillmentId) throw new Error("缺货明细与子单不符");

    const { data: fulfillment } = await supabaseAdmin
      .from("fulfillments" as never)
      .select("id, order_id, location_id")
      .eq("id", data.fulfillmentId)
      .maybeSingle();
    const fRow = fulfillment as { order_id: string; location_id: string | null } | null;
    if (!fRow) throw new Error("子单不存在");

    const { data: order } = await supabaseAdmin
      .from("commerce_orders" as never)
      .select("id, total_amount, shipping_fee, courier_quote_snapshot")
      .eq("id", fRow.order_id)
      .maybeSingle();
    const orderRow = order as
      | { total_amount: number; shipping_fee: number; courier_quote_snapshot: CourierSnapshot }
      | null;
    if (!orderRow) throw new Error("订单不存在");

    const { data: orderItems } = await supabaseAdmin
      .from("commerce_order_items" as never)
      .select("id, location_id, quantity, line_total, title_snapshot, image_snapshot")
      .eq("order_id", fRow.order_id);
    const orderItemRows =
      ((orderItems as
        | {
            id: string;
            location_id: string | null;
            quantity: number;
            line_total: number;
            title_snapshot: string;
            image_snapshot: string | null;
          }[]
        | null) ?? []);

    const { data: shippedFulfillments } = await supabaseAdmin
      .from("fulfillments" as never)
      .select("location_id, status, shipments(id)")
      .eq("order_id", fRow.order_id);
    const shippedLocationIds = new Set<string>();
    for (const row of ((shippedFulfillments as
      | { location_id: string | null; status: string; shipments: { id: string }[] }[]
      | null) ?? [])) {
      if (row.location_id && row.shipments && row.shipments.length > 0) shippedLocationIds.add(row.location_id);
    }

    const { data: refunds } = await supabaseAdmin
      .from("commerce_refunds" as never)
      .select("amount, status")
      .eq("order_id", fRow.order_id);
    const paymentRefundedFen = ((refunds as { amount: number; status: string }[] | null) ?? [])
      .filter((row) => ["pending", "processing", "succeeded"].includes(row.status))
      .reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);

    const { data: intents } = await supabaseAdmin
      .from("commerce_refund_intents" as never)
      .select("amount_fen, state")
      .eq("order_id", fRow.order_id);
    const intentFen = ((intents as { amount_fen: number; state: string }[] | null) ?? [])
      .filter((row) => row.state !== "failed")
      .reduce((sum, row) => sum + row.amount_fen, 0);

    const shortageItemId = itemRow.order_item_id ?? "";
    const snapshot = orderItemRows.find((row) => row.id === shortageItemId);
    const groupOutstanding = orderItemRows
      .filter((row) => row.location_id === fRow.location_id && row.id !== shortageItemId)
      .reduce((sum, row) => sum + row.quantity, 0);

    const quote = computeShortageQuote(
      buildQuoteInput({
        order: orderRow,
        items: orderItemRows,
        shortage: { order_item_id: shortageItemId, quantity: data.quantity },
        shippedLocationIds,
        itemRefundedFen: 0,
        paymentRefundedFen: paymentRefundedFen + intentFen,
        groupOutstandingQuantity: groupOutstanding,
      }),
    );

    const { data: result, error } = await supabaseAdmin.rpc("shortage_report_v1" as never, {
      p_fulfillment_id: data.fulfillmentId,
      p_fulfillment_item_id: data.fulfillmentItemId,
      p_quantity: data.quantity,
      p_reason: data.reason,
      p_client_op_id: data.clientOpId,
      p_reported_by: context.userId,
      p_device_id: null,
      p_quote: {
        ...quote,
        product_name: snapshot?.title_snapshot ?? null,
        image_ref: snapshot?.image_snapshot ?? null,
      },
    } as never);
    if (error) throw new Error(error.message);
    return { ok: true as const, result };
  });
