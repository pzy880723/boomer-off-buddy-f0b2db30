// POST /api/public/handheld/fulfillments/:id/flash-deliver — 同城闪送到付人工登记送达（与 ERP 网页同一 RPC，无快递单号）
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { HANDHELD_CORS, authenticateDevice, resolveSessionUser, err } from "@/server/handheld-auth.server";
import { requireStaffAtDeviceLocation } from "@/server/handheld-fulfillment.server";
import { FlashDeliverBody, flashDeliver } from "@/server/handheld-fulfillment-actions";

export const Route = createFileRoute("/api/public/handheld/fulfillments/$id/flash-deliver")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const staff = await requireStaffAtDeviceLocation(auth.device, await resolveSessionUser(request));
        if (!staff.ok) return staff.response;
        if (!/^[0-9a-f-]{36}$/i.test(params.id)) return err("Invalid fulfillment id", 400, { code: "validation_error" });
        const parsed = FlashDeliverBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return err("Invalid body", 400, { code: "validation_error", detail: parsed.error.issues[0]?.message });
        const b = parsed.data;
        const res = await flashDeliver(supabaseAdmin.rpc.bind(supabaseAdmin) as never, {
          actorUserId: staff.userId,
          locationId: staff.locationId,
          fulfillmentId: params.id,
          lines: b.lines.map((l) => ({ fulfillmentItemId: l.fulfillment_item_id, quantity: l.quantity })),
          idempotencyKey: b.client_op_id,
          note: b.note ?? null,
        });
        return Response.json(res.body.ok ? { ok: true, data: res.body } : { ...res.body, code: res.body.result }, { status: res.status, headers: HANDHELD_CORS });
      },
    },
  },
});
