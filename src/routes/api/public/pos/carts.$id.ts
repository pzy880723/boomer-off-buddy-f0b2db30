import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/carts/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      DELETE: async ({ request, params }) => {
        const { data: cart, error } = await supabaseAdmin
          .from("pos_held_carts" as never)
          .select("id,location_id,status")
          .eq("id", params.id)
          .maybeSingle();
        if (error) return posError(error.message, 500);
        if (!cart) return posError("挂单不存在", 404);
        const row = cart as unknown as { location_id: string; status: string };
        const auth = await authenticatePosUser(request, row.location_id);
        if (!auth.ok) return auth.response;
        if (row.status !== "held") return posError("挂单已经处理", 409);
        const { error: updateError } = await supabaseAdmin
          .from("pos_held_carts" as never)
          .update({ status: "cancelled", updated_at: new Date().toISOString() } as never)
          .eq("id", params.id);
        if (updateError) return posError(updateError.message, 500);
        return posJson({ ok: true, data: { id: params.id, status: "cancelled" } });
      },
    },
  },
});
