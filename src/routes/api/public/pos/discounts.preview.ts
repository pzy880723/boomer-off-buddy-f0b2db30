import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { calculatePosDiscount } from "@/lib/pos/pos-policy";
import {
  POS_CORS,
  authenticatePosUser,
  hasPosManagerRole,
  posError,
  posJson,
} from "@/server/pos-auth.server";

const PreviewBody = z.object({
  location_id: z.string().uuid(),
  items: z
    .array(z.object({ sku_id: z.string().uuid(), quantity: z.number().int().min(1).max(999) }))
    .min(1),
  discount: z.object({
    type: z.enum(["amount", "percentage", "final_price"]),
    value: z.number().nonnegative(),
    reason: z.string().trim().max(200).optional(),
  }),
});

export const Route = createFileRoute("/api/public/pos/discounts/preview")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      POST: async ({ request }) => {
        const parsed = PreviewBody.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return posError("优惠参数不正确", 400, "invalid_discount");
        const auth = await authenticatePosUser(request, parsed.data.location_id);
        if (!auth.ok) return auth.response;

        const skuIds = [...new Set(parsed.data.items.map((item) => item.sku_id))];
        const { data, error } = await supabaseAdmin
          .from("inv_skus")
          .select("id,name,price_tier,sale_ownership,discount_eligible")
          .in("id", skuIds);
        if (error) return posError(error.message, 500);
        const skuMap = new Map(
          (
            (data ?? []) as unknown as Array<{
              id: string;
              name: string;
              price_tier: number;
              sale_ownership: string;
              discount_eligible: boolean;
            }>
          ).map((sku) => [sku.id, sku]),
        );
        if (skuMap.size !== skuIds.length) return posError("部分商品不存在", 404);
        try {
          const lines = parsed.data.items.map((item) => {
            const sku = skuMap.get(item.sku_id)!;
            return {
              sku_id: item.sku_id,
              quantity: item.quantity,
              unit_price: Number(sku.price_tier) || 0,
              discount_eligible: sku.discount_eligible && sku.sale_ownership === "owned",
            };
          });
          const totals = calculatePosDiscount(lines, parsed.data.discount);
          const discountRate =
            totals.eligible_total > 0 ? totals.discount_total / totals.eligible_total : 0;
          const requiresAuthorization =
            !hasPosManagerRole(auth.roles) && (totals.discount_total > 20 || discountRate > 0.1);
          return posJson({
            ok: true,
            data: {
              ...totals,
              lines,
              reason_required: totals.discount_total > 0,
              requires_authorization: requiresAuthorization,
              authorization_rule: requiresAuthorization
                ? "店员单笔优惠超过 20 元或九折，需要店长授权"
                : null,
            },
          });
        } catch (previewError) {
          return posError(
            previewError instanceof Error ? previewError.message : "优惠不可用",
            422,
            "discount_not_allowed",
          );
        }
      },
    },
  },
});
