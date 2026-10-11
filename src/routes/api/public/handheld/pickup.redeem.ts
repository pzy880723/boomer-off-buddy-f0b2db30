// POST /api/public/handheld/pickup/redeem — 扫提货二维码或输入 4 位码核销（commerce_pickup_redeem）
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HANDHELD_CORS, authenticateDevice, resolveSessionUser, err } from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";
import { PickupRedeemBody, handheldPickupRedeem } from "@/server/handheld-fulfillment-actions";

export const Route = createFileRoute("/api/public/handheld/pickup/redeem")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const staff = await requireStaffAtDeviceLocation(auth.device, await resolveSessionUser(request));
        if (!staff.ok) return staff.response;
        const parsed = PickupRedeemBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return err("Invalid body", 400, { code: "validation_error", detail: parsed.error.issues[0]?.message });
        const res = await handheldPickupRedeem(supabaseAdmin.rpc.bind(supabaseAdmin) as never, {
          actorUserId: staff.userId,
          locationId: staff.locationId,
          input: parsed.data.input,
          idempotencyKey: parsed.data.idempotency_key,
          expectedFulfillmentId: parsed.data.expected_fulfillment_id ?? null,
        });
        return Response.json(res.body.ok ? { ok: true, data: res.body } : { ...res.body, code: res.body.result }, { status: res.status, headers: HANDHELD_CORS });
      },
    },
  },
});
