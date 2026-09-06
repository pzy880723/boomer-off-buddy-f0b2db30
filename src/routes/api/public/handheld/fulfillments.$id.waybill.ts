import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";

/**
 * 面单能力：当前没有对接任何真实快递商户账号，因此只暴露能力状态。
 * 在拿到真实 provider 契约前，绝不返回伪造 tracking_no / label_payload。
 */
function carrierCapability() {
  const configured = Boolean(process.env["COURIER_PROVIDER_CODE"]);
  return {
    capability: configured ? "ready" : "carrier_not_configured",
    provider: configured ? process.env["COURIER_PROVIDER_CODE"] : null,
    can_print_waybill: configured,
    message: configured ? "面单服务已配置" : "尚未配置快递商户与电子面单账号，无法申请真实面单",
  };
}

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/waybill")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        const { data } = await supabaseAdmin
          .from("shipments" as never)
          .select("id, provider, tracking_no, status, created_at")
          .eq("fulfillment_id", params.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return ok({ ...carrierCapability(), shipment: data ?? null });
      },
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        const capability = carrierCapability();
        if (!capability.can_print_waybill) {
          return err(capability.message, 409, { code: "carrier_not_configured", ...capability });
        }
        return err("Waybill provider integration not implemented yet", 501, {
          code: "carrier_not_implemented",
        });
      },
    },
  },
});
