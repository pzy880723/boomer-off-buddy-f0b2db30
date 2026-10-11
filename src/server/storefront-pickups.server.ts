// 顾客订单详情的自提凭证：仅在调用方已确认订单归属后使用；凭证不写日志。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildCustomerPickups, type CustomerPickup } from "@/lib/commerce/pickup-view";
import { qrPngDataUrl } from "@/server/qr-png.server";

export type CustomerPickupWithImage = CustomerPickup & { qr_image: string | null };

type OrderLike = { id: string; fulfillment_method: string | null; payment_status: string; order_status: string };

export async function loadCustomerPickups(order: OrderLike): Promise<CustomerPickupWithImage[]> {
  if (order.fulfillment_method !== "pickup") return [];
  const db = supabaseAdmin as unknown as { from: (t: string) => any };
  const [f, c] = await Promise.all([
    db.from("fulfillments").select("id,location_id,status,location:inv_locations!location_id(name,shop:youzan_shops!shop_id(shop_name,address))").eq("order_id", order.id),
    db.from("commerce_pickup_codes").select("fulfillment_id,code,qr_token,status,redeemed_at").eq("order_id", order.id),
  ]);
  for (const x of [f, c]) if (x.error) throw new Error("pickup lookup failed");
  const eligibility = await loadPickupEligibility([order.id]);
  const pickups = buildCustomerPickups({
    order,
    fulfillments: ((f.data ?? []) as Array<{ id: string; location_id: string | null; status: string;
      location: { name: string | null; shop: { shop_name: string | null; address: string | null } | null } | null }>).map((x) => ({
      id: x.id, location_id: x.location_id, status: x.status,
      store_name: x.location?.shop?.shop_name ?? x.location?.name ?? null, store_address: x.location?.shop?.address ?? null })),
    codes: c.data ?? [],
    eligibility,
  });
  return Promise.all(pickups.map(async (p) => ({ ...p, qr_image: p.qr_payload ? await qrPngDataUrl(p.qr_payload) : null })));
}

/** 服务端权威清算资格（与手持备货/核销同一数据库判定）。RPC 失败返回 null → 调用方全部失败关闭，不输出凭证。 */
export async function loadPickupEligibility(orderIds: string[]): Promise<Map<string, string | null> | null> {
  if (orderIds.length === 0) return new Map();
  const db = supabaseAdmin as unknown as { rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }> };
  try {
    const { data, error } = await db.rpc("commerce_storefront_pickup_eligibility", { p_order_ids: orderIds });
    if (error || !Array.isArray(data)) return null;
    return new Map((data as Array<{ fulfillment_id: string; block_reason: string | null }>).map((r) => [r.fulfillment_id, r.block_reason ?? null]));
  } catch {
    return null;
  }
}
