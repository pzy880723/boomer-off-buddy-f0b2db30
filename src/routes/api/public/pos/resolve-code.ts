import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signSkuImagePaths } from "@/lib/sku-image-resolver.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

const SKU_COLUMNS =
  "id,sku_code,barcode,epc,name,kind,is_custom_price,inventory_policy,price_tier,grade,image_url,image_paths,is_display,sale_ownership,discount_eligible";

export const Route = createFileRoute("/api/public/pos/resolve-code")({
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

        const [barcodeResult, skuCodeResult, epcResult] = await Promise.all(
          ["barcode", "sku_code", "epc"].map((field) =>
            supabaseAdmin
              .from("inv_skus")
              .select(SKU_COLUMNS)
              .eq(field, code)
              .eq("status", "active")
              .maybeSingle(),
          ),
        );
        const productResult = [barcodeResult, skuCodeResult, epcResult].find(
          (result) => result.data,
        );
        if (productResult?.data) {
          const sku = productResult.data as unknown as {
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
          };
          if (!sku.is_display) return posError("商品当前未上架", 409, "product_not_selling");
          const { data: availableQty, error: availabilityError } = await supabaseAdmin.rpc(
            "sales_sku_available_qty" as never,
            { p_sku_id: sku.id, p_location_id: locationId } as never,
          );
          if (availabilityError) return posError(availabilityError.message, 500);
          let imageUrl =
            sku.image_url && /^https?:\/\//i.test(sku.image_url) ? sku.image_url : null;
          if (sku.image_paths?.[0]) {
            imageUrl = (await signSkuImagePaths([sku.image_paths[0]]))[0] ?? imageUrl;
          }
          return posJson({
            ok: true,
            data: {
              code_type: "product",
              product: {
                sku_id: sku.id,
                sku_code: sku.sku_code,
                barcode: sku.barcode,
                epc: sku.epc,
                name: sku.name,
                product_type:
                  sku.kind === "bundle" ? "bundle" : sku.is_custom_price ? "custom" : "standard",
                unit_price: Number(sku.price_tier) || 0,
                condition_grade: sku.grade,
                image_url: imageUrl,
                available_qty: Number(availableQty) || 0,
                is_unlimited_stock: sku.inventory_policy === "unlimited",
                location_id: locationId,
                sale_ownership: sku.sale_ownership,
                discount_eligible: sku.discount_eligible,
              },
            },
          });
        }

        const { data: customer, error: customerError } = await supabaseAdmin
          .from("commerce_customers" as never)
          .select("id,phone,nickname,avatar_url,status")
          .eq("phone", code)
          .eq("status", "active")
          .maybeSingle();
        if (customerError) return posError(customerError.message, 500);
        if (customer) {
          return posJson({ ok: true, data: { code_type: "customer", customer } });
        }

        const { data: coupon, error: couponError } = await supabaseAdmin
          .from("pos_customer_coupons" as never)
          .select("id,customer_id,code,name,discount_type,value,min_spend,expires_at,status")
          .eq("code", code)
          .eq("status", "active")
          .maybeSingle();
        if (couponError) return posError(couponError.message, 500);
        if (coupon) return posJson({ ok: true, data: { code_type: "coupon", coupon } });
        return posError("未识别到商品、会员或优惠券", 404, "code_not_found");
      },
    },
  },
});
