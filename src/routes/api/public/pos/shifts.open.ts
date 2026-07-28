import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const OpenShiftBody = z.object({
  location_id: z.string().uuid(),
  register_code: z.string().trim().min(1).max(40),
  register_name: z.string().trim().min(1).max(80),
  opening_cash: z.number().min(0).max(1_000_000).optional(),
});

export const Route = createFileRoute("/api/public/pos/shifts/open")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        let body: z.infer<typeof OpenShiftBody>;
        try {
          body = OpenShiftBody.parse(await request.json());
        } catch (error) {
          return posError(`参数错误：${String(error)}`, 400);
        }
        const auth = await authenticatePosUser(request, body.location_id);
        if (!auth.ok) return auth.response;
        const { data: register, error: registerError } = await supabaseAdmin
          .from("pos_registers" as never)
          .upsert(
            {
              location_id: body.location_id,
              code: body.register_code,
              name: body.register_name,
              is_active: true,
              updated_at: new Date().toISOString(),
            } as never,
            { onConflict: "location_id,code" },
          )
          .select("id,location_id,code,name,receipt_prefix")
          .single();
        if (registerError || !register)
          return posError(registerError?.message ?? "收银机创建失败", 500);

        const registerRow = register as unknown as { id: string };
        const { data: existing } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("*")
          .eq("register_id", registerRow.id)
          .in("status", ["open", "closing"])
          .maybeSingle();
        if (existing) {
          const existingRow = existing as unknown as { operator_id: string };
          if (existingRow.operator_id === auth.user.id) {
            return posJson({ ok: true, data: existing, replayed: true });
          }
          return posError("该收银机已有其他员工开班", 409, "register_in_use");
        }

        const { data: previousShift, error: previousShiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("counted_cash,expected_cash")
          .eq("register_id", registerRow.id)
          .eq("status", "closed")
          .order("closed_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (previousShiftError) return posError(previousShiftError.message, 500);
        const previous = previousShift as unknown as {
          counted_cash: number | null;
          expected_cash: number | null;
        } | null;
        const carriedCash = Number(previous?.counted_cash ?? previous?.expected_cash ?? 0);

        const { data: shift, error: shiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .insert({
            register_id: registerRow.id,
            location_id: body.location_id,
            operator_id: auth.user.id,
            opening_cash: carriedCash,
          } as never)
          .select("*")
          .single();
        if (shiftError) return posError(shiftError.message, 500);
        return posJson({ ok: true, data: shift }, { status: 201 });
      },
    },
  },
});
