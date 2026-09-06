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
import {
  buildFulfillmentTicket,
  requireStaffAtDeviceLocation,
} from "@/server/handheld-fulfillment.server";

const Body = z.object({
  limit: z.number().int().min(1).max(20).default(5),
  lease_seconds: z.number().int().min(15).max(600).default(120),
});

export const Route = createFileRoute("/api/public/handheld/print-jobs/lease")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const location = requireLocation(auth.device);
        if (!location.ok) return location.response;
        const session = await resolveSessionUser(request);
        const staff = await requireStaffAtDeviceLocation(auth.device, session);
        if (!staff.ok) return staff.response;
        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json().catch(() => ({})));
        } catch (error) {
          return err(`Invalid body: ${String(error)}`, 400, { code: "validation_error" });
        }
        const { data, error } = await supabaseAdmin.rpc(
          "print_jobs_lease" as never,
          {
            p_location_id: staff.locationId,
            p_device_id: auth.device.id,
            p_limit: body.limit,
            p_lease_seconds: body.lease_seconds,
          } as never,
        );
        if (error) return err(error.message, 500);
        const jobs = (data as unknown as Array<{
          id: string;
          fulfillment_id: string;
          ticket_type: string;
          status: string;
          lease_expires_at: string | null;
          attempts: number;
        }>) ?? [];
        const items = await Promise.all(
          jobs.map(async (job) => {
            let ticket = null;
            if (job.ticket_type === "pick_ticket") {
              const built = await buildFulfillmentTicket({
                fulfillmentId: job.fulfillment_id,
                locationId: staff.locationId,
              });
              ticket = built.ok ? built.ticket : null;
            }
            return { ...job, ticket };
          }),
        );
        // 只是租约，未收到 ack 前不代表已物理打印
        return ok({ items, leased: items.length });
      },
    },
  },
});
