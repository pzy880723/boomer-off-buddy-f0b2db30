// POST /api/public/handheld/pickup/ready — 标记自提子单备货完成（commerce_pickup_mark_ready）
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HANDHELD_CORS, authenticateDevice, resolveSessionUser, err } from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";
import { PickupReadyBody, handheldPickupReady } from "@/server/handheld-fulfillment-actions";

export const Route = createFileRoute("/api/public/handheld/pickup/ready")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const staff = await requireStaffAtDeviceLocation(auth.device, await resolveSessionUser(request));
        if (!staff.ok) return staff.response;
        const parsed = PickupReadyBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return err("Invalid body", 400, { code: "validation_error", detail: parsed.error.issues[0]?.message });
        const res = await handheldPickupReady(supabaseAdmin.rpc.bind(supabaseAdmin) as never, {
          actorUserId: staff.userId,
          locationId: staff.locationId,
          fulfillmentId: parsed.data.fulfillment_id,
          idempotencyKey: parsed.data.idempotency_key,
        });
        return Response.json(res.body.ok ? { ok: true, data: res.body } : { ...res.body, code: res.body.result }, { status: res.status, headers: HANDHELD_CORS });
      },
    },
  },
});
