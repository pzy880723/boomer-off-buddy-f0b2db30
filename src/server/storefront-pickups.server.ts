// 顾客订单详情的自提凭证：仅在调用方已确认订单归属后使用；凭证不写日志。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildCustomerPickups, type CustomerPickup } from "@/lib/commerce/pickup-view";

type OrderLike = { id: string; fulfillment_method: string | null; payment_status: string; order_status: string };

export async function loadCustomerPickups(order: OrderLike): Promise<CustomerPickup[]> {
  if (order.fulfillment_method !== "pickup") return [];
  const db = supabaseAdmin as unknown as { from: (t: string) => any };
  const [f, c, r, ri, s] = await Promise.all([
    db.from("fulfillments").select("id,location_id,status,location:inv_locations!location_id(name,shop:youzan_shops!shop_id(shop_name,address))").eq("order_id", order.id),
    db.from("commerce_pickup_codes").select("fulfillment_id,code,qr_token,status,redeemed_at").eq("order_id", order.id),
    db.from("commerce_refunds").select("id").eq("order_id", order.id).in("status", ["pending", "processing", "succeeded"]).limit(1),
    db.from("commerce_refund_intents").select("id").eq("order_id", order.id).in("state", ["queued", "processing", "manual_review", "succeeded"]).limit(1),
    db.from("fulfillment_shortages").select("fulfillment_id").eq("order_id", order.id).in("status", ["pending_customer", "customer_accepted"]),
  ]);
  for (const x of [f, c, r, ri, s]) if (x.error) throw new Error("pickup lookup failed");
  return buildCustomerPickups({
    order,
    fulfillments: (f.data ?? []).map((row: any) => ({
      id: row.id, location_id: row.location_id, status: row.status,
      store_name: row.location?.shop?.shop_name ?? row.location?.name ?? null,
      store_address: row.location?.shop?.address ?? null,
    })),
    codes: c.data ?? [],
    refundActive: (r.data ?? []).length > 0 || (ri.data ?? []).length > 0,
    shortageFulfillmentIds: (s.data ?? []).map((x: { fulfillment_id: string }) => x.fulfillment_id),
  });
}
