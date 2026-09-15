/**
 * ERP 侧：网店订单门店子单详情、手工发货（快递公司 + 单号 + 本次数量）、缺货申报。
 * 手工发货不依赖电子面单；缺货申报走 SECURITY DEFINER RPC，原子锁定可申报数量。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { computeQuoteFromFacts } from "@/lib/shortage-refund/facts";
import { loadOrderSnapshot, loadQuoteFacts } from "@/lib/shortage-refund/facts.server";

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
    const orderRow = await loadOrderSnapshot(fRow.order_id);
    if (!orderRow) throw new Error("订单不存在");

    // 与旧单补报价共用同一条安全报价路径（同样的去重、上限、运费防重口径）
    const { facts, snapshots } = await loadQuoteFacts(orderRow);
    const shortageItemId = itemRow.order_item_id ?? "";
    const snapshot = snapshots.get(shortageItemId);
    const quote = computeQuoteFromFacts(facts, {
      shortageId: null,
      orderItemId: shortageItemId,
      locationId: fRow.location_id,
      quantity: data.quantity,
    });

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
