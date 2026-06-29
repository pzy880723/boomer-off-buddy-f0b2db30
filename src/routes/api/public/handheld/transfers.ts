import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/transfers")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id") || auth.device.location_id;
        if (!locationId) return err("Missing location_id", 400, { code: "no_location" });
        const status = url.searchParams.get("status");
        const role = url.searchParams.get("role"); // "incoming" | "outgoing" | undefined

        let qb = supabaseAdmin
          .from("stock_transfers")
          .select(
            "id, code, status, qty, from_location_id, to_location_id, shipped_at, received_at, created_at, notes",
          )
          .order("created_at", { ascending: false })
          .limit(50);
        if (role === "incoming") qb = qb.eq("to_location_id", locationId);
        else if (role === "outgoing") qb = qb.eq("from_location_id", locationId);
        else qb = qb.or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`);
        if (status) qb = qb.eq("status", status);

        const { data, error } = await qb;
        if (error) return err(error.message, 500);
        return ok({ items: data ?? [] });
      },
    },
  },
});
