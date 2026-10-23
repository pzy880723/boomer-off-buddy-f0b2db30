// POST /api/public/handheld/items/smart-create/cancel
// Atomic cancel-or-recover for one photo-listing op. Body = the ORIGINAL smart-create body (same client_op_id),
// so the server recomputes the identical fingerprint. Serialized with the commit by the op lock:
//  - op absent  → persistent tombstone, state=cancelled; any late original request is rejected (409 client_op_cancelled), no SKU.
//  - committed  → state=committed; retry the ORIGINAL smart-create with the same client_op_id to finish (never a new op).
//  - completed  → state=completed with the original success receipt.
// Different user/location/payload → 409 client_op_id_conflict (nothing changed). Never creates or deletes a SKU.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HANDHELD_CORS, authenticateDevice, err, ok, resolveSessionUser, userCanAccessLocation } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SmartCreateReq } from "@/lib/handheld/schemas";
import { smartCreateRequestFingerprint } from "@/server/handheld-smart-create.server";

const CancelReq = SmartCreateReq.and(z.object({ client_op_id: z.string().trim().min(8).max(100) }));

export const Route = createFileRoute("/api/public/handheld/items/smart-create/cancel")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const parsed = CancelReq.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return err("Invalid body", 400, { code: "validation_error" });
        const body = parsed.data;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const locationId = body.location_id ?? auth.device.location_id;
        if (!locationId) return err("No target location", 400, { code: "validation_error" });
        if (!(await userCanAccessLocation(session.user_id, locationId)))
          return err("Location not accessible", 403, { code: "location_forbidden" });
        const { fingerprint } = smartCreateRequestFingerprint(body, locationId);
        const { data, error } = await supabaseAdmin.rpc("handheld_smart_create_cancel" as never, {
          p_device_id: auth.device.id,
          p_user_id: session.user_id,
          p_client_op_id: body.client_op_id,
          p_fingerprint: fingerprint,
          p_location_id: locationId,
        } as never);
        if (error) {
          if ((error as { code?: string }).code === "P0409")
            return err("client_op_id belongs to a different payload, user or location", 409, { code: "client_op_id_conflict" });
          // Outcome unknown: keep the lock and retry this same cancel request.
          return err("Unable to confirm listing operation; retry the same cancel request", 503, { code: "smart_create_cancel_unknown" });
        }
        const r = data as { state?: unknown; replayed?: unknown; sku_id?: unknown; response?: unknown } | null;
        // Malformed/contradictory DB result = outcome unknown: never let the client clear its lock on it.
        const wellFormed = !!r && typeof r.replayed === "boolean" && (
          (r.state === "cancelled" && r.sku_id == null)
          || ((r.state === "committed" || r.state === "completed") && typeof r.sku_id === "string" && r.sku_id.length > 0)
        ) && (r.state !== "completed" || (!!r.response && typeof r.response === "object"));
        if (!wellFormed)
          return err("Unable to confirm listing operation; retry the same cancel request", 503, { code: "smart_create_cancel_unknown" });
        return ok({
          client_op_id: body.client_op_id,
          state: r.state,
          replayed: r.replayed,
          sku_id: r.sku_id,
          receipt: r.state === "completed" ? r.response : null,
        });
      },
    },
  },
});
