import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const HoldBody = z.object({
  shift_id: z.string().uuid(),
  client_op_id: z.string().trim().min(8).max(100),
  customer_id: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(200).optional(),
  discount_snapshot: z.record(z.string(), z.unknown()).optional(),
  benefit_snapshot: z.record(z.string(), z.unknown()).optional(),
  items: z
    .array(z.object({ sku_id: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100),
});

export const Route = createFileRoute("/api/public/pos/carts/hold")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        const parsed = HoldBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("挂单参数不正确", 400);
        const { data: shift, error: shiftError } = await supabaseAdmin
          .from("pos_shifts" as never)
          .select("id,location_id,operator_id,status")
          .eq("id", parsed.data.shift_id)
          .maybeSingle();
        if (shiftError) return posError(shiftError.message, 500);
        if (!shift) return posError("收银班次不存在", 404);
        const shiftRow = shift as unknown as {
          location_id: string;
          operator_id: string;
          status: string;
        };
        const auth = await authenticatePosUser(request, shiftRow.location_id);
        if (!auth.ok) return auth.response;
        if (shiftRow.operator_id !== auth.user.id || shiftRow.status !== "open") {
          return posError("当前班次不可挂单", 403);
        }

        const skuIds = [...new Set(parsed.data.items.map((item) => item.sku_id))];
        const { data: skus, error: skuError } = await supabaseAdmin
          .from("inv_skus")
          .select("id,price_tier,sale_ownership,discount_eligible")
          .in("id", skuIds);
        if (skuError) return posError(skuError.message, 500);
        const skuMap = new Map(
          (
            (skus ?? []) as unknown as Array<{
              id: string;
              price_tier: number;
              sale_ownership: string;
              discount_eligible: boolean;
            }>
          ).map((sku) => [sku.id, sku]),
        );
        if (skuMap.size !== skuIds.length) return posError("部分商品不存在", 404);

        const { data: heldCart, error: cartError } = await supabaseAdmin
          .from("pos_held_carts" as never)
          .insert({
            shift_id: parsed.data.shift_id,
            location_id: shiftRow.location_id,
            operator_id: auth.user.id,
            customer_id: parsed.data.customer_id ?? null,
            client_op_id: parsed.data.client_op_id,
            note: parsed.data.note ?? null,
            discount_snapshot: parsed.data.discount_snapshot ?? {},
            benefit_snapshot: parsed.data.benefit_snapshot ?? {},
          } as never)
          .select("id,status,held_at")
          .single();
        if (cartError) {
          if (/duplicate|unique/i.test(cartError.message)) {
            const { data: existing } = await supabaseAdmin
              .from("pos_held_carts" as never)
              .select("id,status,held_at")
              .eq("client_op_id", parsed.data.client_op_id)
              .maybeSingle();
            return posJson({ ok: true, data: existing, replayed: true });
          }
          return posError(cartError.message, 500);
        }
        const cartId = (heldCart as unknown as { id: string }).id;
        const rows = parsed.data.items.map((item) => {
          const sku = skuMap.get(item.sku_id)!;
          return {
            held_cart_id: cartId,
            sku_id: item.sku_id,
            quantity: item.quantity,
            price_snapshot: Number(sku.price_tier) || 0,
            ownership_snapshot: sku.sale_ownership,
            discount_eligible: sku.discount_eligible,
          };
        });
        const { error: itemError } = await supabaseAdmin
          .from("pos_held_cart_items" as never)
          .insert(rows as never);
        if (itemError) {
          await supabaseAdmin
            .from("pos_held_carts" as never)
            .delete()
            .eq("id", cartId);
          return posError(itemError.message, 500);
        }
        return posJson({ ok: true, data: heldCart }, { status: 201 });
      },
    },
  },
});
