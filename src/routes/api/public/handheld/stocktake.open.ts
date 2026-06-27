import { createFileRoute } from "@tanstack/react-router";
import type { z } from "zod";
import {
  HANDHELD_CORS,
  authenticateDevice,
  requireLocation,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { StocktakeOpenReq as Body } from "@/lib/handheld/schemas";

function code() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ST-${ymd}-${r}`;
}

export const Route = createFileRoute("/api/public/handheld/stocktake/open")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const need = requireLocation(auth.device);
        if (!need.ok) return need.response;

        let payload: z.infer<typeof Body> = {};
        try {
          payload = Body.parse(await request.json().catch(() => ({})));
        } catch {
          // ignore
        }

        // Reuse existing scanning stocktake for this location if any
        const { data: existing } = await supabaseAdmin
          .from("stocktakes")
          .select("id, code, status, opened_at")
          .eq("location_id", auth.device.location_id!)
          .eq("status", "scanning")
          .order("opened_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existing) return ok({ ...existing, reused: true });

        const { data, error } = await supabaseAdmin
          .from("stocktakes")
          .insert({
            code: code(),
            location_id: auth.device.location_id!,
            status: "scanning",
            notes: payload.name ?? null,
          })
          .select("id, code, status, opened_at")
          .single();
        if (error) return err(error.message, 500);
        return ok({ ...data, reused: false });
      },
    },
  },
});
