import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signSkuImagePaths } from "@/lib/sku-image-resolver.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const SKU_COLUMNS =
  "id,sku_code,barcode,name,kind,is_custom_price,price_tier,grade,image_url,image_paths";

export const Route = createFileRoute("/api/public/pos/products")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const locationId = url.searchParams.get("location_id")?.trim();
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (!locationId) return posError("location_id 必填", 400);
        const auth = await authenticatePosUser(request, locationId);
        if (!auth.ok) return auth.response;

        let skuQuery = supabaseAdmin
          .from("inv_skus")
          .select(SKU_COLUMNS)
          .eq("status", "active")
          .eq("is_display", true)
          .order("updated_at", { ascending: false })
          .limit(24);
        if (query) {
          const escaped = query.replace(/[%_,()]/g, " ");
          skuQuery = skuQuery.or(
            `name.ilike.%${escaped}%,sku_code.ilike.%${escaped}%,barcode.ilike.%${escaped}%`,
          );
        }
        const { data, error } = await skuQuery;
        if (error) return posError(error.message, 500);

        const rows = (data ?? []) as unknown as Array<{
          id: string;
          sku_code: string | null;
          barcode: string | null;
          name: string;
          kind: string;
          is_custom_price: boolean;
          price_tier: number;
          grade: string | null;
          image_url: string | null;
          image_paths: string[] | null;
        }>;
        let items;
        try {
          items = await Promise.all(
            rows.map(async (sku) => {
              const { data: availableQty, error: availabilityError } = await supabaseAdmin.rpc(
                "sales_sku_available_qty" as never,
                { p_sku_id: sku.id, p_location_id: locationId } as never,
              );
              if (availabilityError) throw availabilityError;
              let imageUrl =
                sku.image_url && /^https?:\/\//i.test(sku.image_url) ? sku.image_url : null;
              if (sku.image_paths?.[0]) {
                imageUrl = (await signSkuImagePaths([sku.image_paths[0]]))[0] ?? imageUrl;
              }
              return {
                sku_id: sku.id,
                sku_code: sku.sku_code,
                barcode: sku.barcode,
                name: sku.name,
                product_type:
                  sku.kind === "bundle" ? "bundle" : sku.is_custom_price ? "custom" : "standard",
                unit_price: Number(sku.price_tier) || 0,
                condition_grade: sku.grade,
                image_url: imageUrl,
                available_qty: Number(availableQty) || 0,
                location_id: locationId,
              };
            }),
          );
        } catch (availabilityError) {
          return posError(
            availabilityError instanceof Error ? availabilityError.message : "读取可售库存失败",
            500,
          );
        }
        return posJson({
          ok: true,
          data: { items: items.filter((item) => item.available_qty > 0) },
        });
      },
    },
  },
});
