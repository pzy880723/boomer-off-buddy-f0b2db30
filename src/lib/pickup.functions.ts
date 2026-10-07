// ERP 门店自提：核销 / 备货完成 / 可核销门店。全部经登录鉴权，门店权限在数据库 RPC 内再验证。
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parsePickupInput, pickupResultMessage } from "@/lib/commerce/pickup-view";

const idem = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
export type PickupActionResult = { ok: boolean; result: string; message: string; fulfillment_id?: string; order_id?: string; redeemed_at?: string; replayed?: boolean };

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    from: (t: string) => any;
  };
}

function toResult(data: unknown): PickupActionResult {
  const r = (data ?? {}) as Record<string, unknown>;
  const result = typeof r.result === "string" ? r.result : "unknown";
  return {
    ok: r.ok === true, result, message: pickupResultMessage(result),
    ...(typeof r.fulfillment_id === "string" ? { fulfillment_id: r.fulfillment_id } : {}),
    ...(typeof r.order_id === "string" ? { order_id: r.order_id } : {}),
    ...(typeof r.redeemed_at === "string" ? { redeemed_at: r.redeemed_at } : {}),
    ...(r.replayed === true ? { replayed: true } : {}),
  };
}

/** 扫码枪文本或手输 4 位码核销；门店必须显式指定。订单内核销按钮同样调用本函数。 */
export const redeemPickup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    location_id: z.string().uuid(),
    input: z.string().max(200),
    idempotency_key: idem,
    expected_fulfillment_id: z.string().uuid().optional(),
  }).strict().parse(input))
  .handler(async ({ data, context }): Promise<PickupActionResult> => {
    const parsed = parsePickupInput(data.input);
    if (!parsed) return { ok: false, result: "invalid_input", message: pickupResultMessage("invalid_input") };
    const sb = await admin();
    const { data: res, error } = await sb.rpc("commerce_pickup_redeem", {
      p_actor_user_id: context.userId,
      p_location_id: data.location_id,
      p_qr_payload: parsed.kind === "qr" ? parsed.value : null,
      p_code: parsed.kind === "code" ? parsed.value : null,
      p_idempotency_key: data.idempotency_key,
      p_expected_fulfillment_id: data.expected_fulfillment_id ?? null,
    });
    if (error) throw new Error("核销服务暂时不可用，请稍后重试");
    return toResult(res);
  });

export const markPickupReady = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({
    location_id: z.string().uuid(), fulfillment_id: z.string().uuid(), idempotency_key: idem,
  }).strict().parse(input))
  .handler(async ({ data, context }): Promise<PickupActionResult> => {
    const sb = await admin();
    const { data: res, error } = await sb.rpc("commerce_pickup_mark_ready", {
      p_actor_user_id: context.userId, p_location_id: data.location_id,
      p_fulfillment_id: data.fulfillment_id, p_idempotency_key: data.idempotency_key,
    });
    if (error) throw new Error("备货服务暂时不可用，请稍后重试");
    const r = toResult(res);
    return r.result === "not_found" ? { ...r, message: pickupResultMessage("not_found_fulfillment") } : r;
  });

/** 当前员工可核销的门店（与 RPC 内的 scope 规则一致；仅用于选择，RPC 仍会再验证）。 */
export const listPickupLocations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Array<{ id: string; name: string }>> => {
    const sb = await admin();
    const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", context.userId);
    const rs = ((roles ?? []) as { role: string }[]).map((r) => r.role);
    const hq = rs.includes("super_admin") || rs.includes("hq_operator");
    const staff = rs.includes("store_manager") || rs.includes("store_staff");
    if (!hq && !staff) return [];
    let q = sb.from("inv_locations").select("id,name").eq("kind", "shop").eq("is_active", true).order("name");
    if (!hq) {
      const { data: perms } = await sb.from("user_location_perms").select("location_id").eq("user_id", context.userId);
      const ids = ((perms ?? []) as { location_id: string }[]).map((p) => p.location_id);
      if (ids.length === 0) return [];
      q = q.in("id", ids);
    }
    const { data: rows } = await q;
    return (rows ?? []) as Array<{ id: string; name: string }>;
  });
