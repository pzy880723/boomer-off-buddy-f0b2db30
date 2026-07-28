import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  POS_CORS,
  authenticatePosUser,
  hasPosManagerRole,
  posError,
  posJson,
} from "@/server/pos-auth.server";

const AuthorizationBody = z.object({
  location_id: z.string().uuid(),
  operator_id: z.string().uuid(),
  action: z.enum(["order_discount", "line_discount", "return", "void_sale"]),
  requested_value: z.record(z.string(), z.unknown()).default({}),
  approved_value: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().min(2).max(200),
});

export const Route = createFileRoute("/api/public/pos/authorizations")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        const parsed = AuthorizationBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("授权参数不正确", 400);
        const auth = await authenticatePosUser(request, parsed.data.location_id);
        if (!auth.ok) return auth.response;
        if (!hasPosManagerRole(auth.roles)) {
          return posError("需要店长或总部账号授权", 403, "manager_required");
        }
        const { data, error } = await supabaseAdmin
          .from("pos_authorizations" as never)
          .insert({
            location_id: parsed.data.location_id,
            operator_id: parsed.data.operator_id,
            authorizer_id: auth.user.id,
            action: parsed.data.action,
            requested_value: parsed.data.requested_value,
            approved_value: parsed.data.approved_value ?? parsed.data.requested_value,
            reason: parsed.data.reason,
            status: "approved",
          } as never)
          .select("id,status,expires_at,authorizer_id")
          .single();
        if (error) return posError(error.message, 500);
        return posJson({ ok: true, data }, { status: 201 });
      },
    },
  },
});
