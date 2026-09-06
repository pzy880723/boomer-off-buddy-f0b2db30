import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  err,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DiagReportReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/diag/report")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: ReturnType<typeof DiagReportReq.parse>;
        try {
          body = DiagReportReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { code: "validation_error", detail: String(e) });
        }
        const session = await resolveSessionUser(request);

        const { data, error } = await supabaseAdmin
          .from("inv_handheld_diag" as never)
          .insert({
            device_id: auth.device.id,
            user_id: session?.user_id ?? null,
            kind: body.kind,
            message: body.message.slice(0, 4000),
            payload: body.payload ?? null,
            app_version: body.app_version ?? auth.device.app_version ?? null,
            os_version: body.os_version ?? auth.device.os_version ?? null,
          } as never)
          .select("id")
          .single();
        if (error || !data) return err(`insert failed: ${error?.message ?? "no data"}`, 500);

        return ok({ id: (data as any).id });
      },
    },
  },
});
