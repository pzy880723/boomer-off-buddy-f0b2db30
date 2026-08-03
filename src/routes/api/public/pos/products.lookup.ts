import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const SKU_COLUMNS =
  "id,sku_code,barcode,epc,name,kind,is_custom_price,inventory_policy,price_tier,grade,image_url,image_paths,status,is_display,sale_ownership,discount_eligible";

export const Route = createFileRoute("/api/public/pos/products/lookup")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code")?.trim();
        const locationId = url.searchParams.get("location_id")?.trim();
        if (!code || !locationId) return posError("code 和 location_id 必填", 400);
        const auth = await authenticatePosUser(request, locationId);
        if (!auth.ok) return auth.response;

        const results = await Promise.all(
          ["id", "barcode", "sku_code", "epc"].map((field) =>
            supabaseAdmin
              .from("inv_skus")
              .select(SKU_COLUMNS)
              .eq(field, code)
              .eq("status", "active")
              .maybeSingle(),
          ),
        );
        const failed = results.find((result) => result.error);
        if (failed?.error) return posError(failed.error.message, 500);
        const sku = results.find((result) => result.data)?.data as
          | {
              id: string;
              sku_code: string | null;
              barcode: string | null;
              epc: string | null;
              name: string;
              kind: string;
              is_custom_price: boolean;
              inventory_policy: "tracked" | "unlimited";
              price_tier: number;
              grade: string | null;
              image_url: string | null;
              image_paths: string[] | null;
              is_display: boolean;
              sale_ownership: string;
              discount_eligible: boolean;
            }
          | undefined;
        if (!sku || !sku.is_display) return posError("未找到可售商品", 404, "product_not_found");

        const { data: availableQty, error: availabilityError } = await supabaseAdmin.rpc(
          "sales_sku_available_qty" as never,
          { p_sku_id: sku.id, p_location_id: locationId } as never,
        );
        if (availabilityError) return posError(availabilityError.message, 500);
        const productType =
          sku.kind === "bundle" ? "bundle" : sku.is_custom_price ? "custom" : "standard";
        const { locationInheritsStandardCatalog, isGlobalStandardItem } = await import(
          "@/server/standard-catalog-scope.server"
        );
        if (
          isGlobalStandardItem({
            product_type: productType,
            is_unlimited_stock: sku.inventory_policy === "unlimited",
          }) &&
          !(await locationInheritsStandardCatalog(locationId))
        ) {
          return posError("未找到可售商品", 404, "product_not_found");
        }

        let imageUrl = sku.image_url && /^https?:\/\//i.test(sku.image_url) ? sku.image_url : null;
        if (sku.image_paths?.[0]) {
          const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
          imageUrl = (await signSkuImagePaths([sku.image_paths[0]]))[0] ?? imageUrl;
        }
        return posJson({
          ok: true,
          data: {
            sku_id: sku.id,
            sku_code: sku.sku_code,
            barcode: sku.barcode,
            epc: sku.epc,
            name: sku.name,
            product_type: productType,
            unit_price: Number(sku.price_tier) || 0,
            condition_grade: sku.grade,
            image_url: imageUrl,
            available_qty: Number(availableQty) || 0,
            is_unlimited_stock: sku.inventory_policy === "unlimited",
            location_id: locationId,
            sale_ownership: sku.sale_ownership,
            discount_eligible: sku.discount_eligible,
          },
        });
      },
    },
  },
});
