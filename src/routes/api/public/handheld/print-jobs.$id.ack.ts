import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
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

const Body = z.object({
  status: z.enum(["acked", "failed", "unknown"]),
  error: z.string().trim().max(400).optional(),
});

export const Route = createFileRoute("/api/public/handheld/print-jobs/$id/ack")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (error) {
          return err(`Invalid body: ${String(error)}`, 400, { code: "validation_error" });
        }
        const { data: job } = await supabaseAdmin
          .from("print_jobs" as never)
          .select("id, status, lease_device_id, location_id")
          .eq("id", params.id)
          .eq("location_id", staff.locationId)
          .maybeSingle();
        if (!job) return err("Print job not found", 404, { code: "not_found" });
        const row = job as unknown as { id: string; status: string; lease_device_id: string | null };
        if (row.lease_device_id && row.lease_device_id !== auth.device.id) {
          return err("Print job leased by another device", 409, { code: "lease_conflict" });
        }
        if (row.status === "acked") return ok({ id: row.id, status: "acked", replayed: true });
        const { data, error } = await supabaseAdmin
          .from("print_jobs" as never)
          .update({
            status: body.status,
            acked_at: body.status === "acked" ? new Date().toISOString() : null,
            last_error: body.error ?? null,
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", params.id)
          .select("id, status, attempts, acked_at, last_error")
          .single();
        if (error) return err(error.message, 500);
        return ok({ ...(data as object), replayed: false });
      },
    },
  },
});
