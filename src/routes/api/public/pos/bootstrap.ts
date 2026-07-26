import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/bootstrap")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticatePosUser(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id");
        if (locationId && !auth.locations.some((location) => location.id === locationId)) {
          return posError("无权访问该库位", 403, "location_forbidden");
        }
        const locationIds = locationId
          ? [locationId]
          : auth.locations.map((location) => location.id);
        if (locationIds.length === 0) {
          return posJson({ ok: true, data: { locations: [], registers: [], open_shifts: [] } });
        }
        const [registerResult, shiftResult] = await Promise.all([
          supabaseAdmin
            .from("pos_registers" as never)
            .select("id,location_id,code,name,receipt_prefix,is_active,settings")
            .in("location_id", locationIds)
            .eq("is_active", true),
          supabaseAdmin
            .from("pos_shifts" as never)
            .select(
              "id,register_id,location_id,operator_id,status,opening_cash,opened_at,register:pos_registers(name,code)",
            )
            .in("location_id", locationIds)
            .eq("operator_id", auth.user.id)
            .in("status", ["open", "closing"]),
        ]);
        if (registerResult.error) return posError(registerResult.error.message, 500);
        if (shiftResult.error) return posError(shiftResult.error.message, 500);
        return posJson({
          ok: true,
          data: {
            user: { ...auth.user, roles: auth.roles },
            locations: auth.locations,
            registers: registerResult.data ?? [],
            open_shifts: shiftResult.data ?? [],
          },
        });
      },
    },
  },
});
