import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  ok,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import {
  handleItemDelete,
  handleItemPatch,
  loadItemCapabilities,
} from "@/server/handheld-item-edit.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { errCode } from "@/lib/handheld/errors";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildPrintPayload } from "@/server/handheld-print.server";
import {
  authorizeProductScope,
  loadProductInventory,
  loadScopedProductSkus,
  buildProductItems,
  signProductItems,
  productReadError,
} from "@/server/handheld-products.server";

export const Route = createFileRoute("/api/public/handheld/items/$id")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          const scope = await authorizeProductScope(request, auth.device);
          const inventory = await loadProductInventory(scope, params.id);
          const [sku] = await loadScopedProductSkus(inventory, (query) =>
            query.eq("id", params.id),
          );
          if (!sku) return errCode("not_found", "SKU not found");

          // Read persisted detail metadata only after location membership is established.
          const { data: metadata, error: metadataError } = await supabaseAdmin
            .from("inv_skus")
            .select(
              "weight_g, attributes, brand_id, brand_candidate_text, ip_id, ip_candidate_text",
            )
            .eq("id", sku.id)
            .maybeSingle();
          if (metadataError || !metadata) throw metadataError ?? new Error("SKU metadata missing");
          const attributes =
            metadata.attributes &&
            typeof metadata.attributes === "object" &&
            !Array.isArray(metadata.attributes)
              ? metadata.attributes
              : {};
          let ipName = metadata.ip_candidate_text;
          if (metadata.ip_id) {
            const { data: ip, error: ipError } = await supabaseAdmin
              .from("inv_brands")
              .select("name")
              .eq("id", metadata.ip_id)
              .eq("entity_type", "ip")
              .maybeSingle();
            if (ipError) throw ipError;
            ipName = ip?.name ?? ipName;
          }

          const { data: facetLinks, error: facetError } = await supabaseAdmin
            .from("inv_sku_facets" as never)
            .select("source, facet:inv_facets(code, name, dimension)")
            .eq("sku_id", sku.id);
          if (facetError) return errCode("internal_error", facetError.message);
          const facets = (
            (facetLinks ?? []) as unknown as Array<{
              source: string;
              facet: { code: string; name: string; dimension: string } | null;
            }>
          )
            .filter((row) => row.facet)
            .map((row) => ({ ...row.facet!, source: row.source }));
          const [item] = await signProductItems(buildProductItems([sku], inventory));
          const session = await resolveSessionUser(request);
          const capabilities = session
            ? await loadItemCapabilities({
                userId: session.user_id,
                locationId: scope.scope.startsWith("location:") ? scope.scope.slice(9) : null,
                skuId: sku.id,
                productType: item.product_type,
                status: sku.status,
              })
            : { can_edit: false, can_delete: false };

          return ok({
            scope: scope.scope,
            id: sku.id,
            can_edit: capabilities.can_edit,
            can_delete: capabilities.can_delete,
            product_type: item.product_type,
            editable: item.editable,
            is_unlimited_stock: item.is_unlimited_stock,
            sku_code: sku.sku_code,
            barcode: sku.barcode ?? null,
            epc: sku.epc,
            name: sku.name,
            category: sku.category,
            attributes,
            brand: typeof attributes.brand === "string" ? attributes.brand : null,
            era: typeof attributes.era === "string" ? attributes.era : null,
            brand_id: metadata.brand_id,
            brand_candidate_text: metadata.brand_candidate_text,
            ip_id: metadata.ip_id,
            ip_candidate_text: metadata.ip_candidate_text,
            ip_name: ipName,
            facet_codes: facets.map((facet) => facet.code),
            tags: facets.map((facet) => facet.name),
            facets,
            price_tier: sku.price_tier,
            is_custom_price: sku.is_custom_price,
            condition_grade: item.condition_grade,
            grade: sku.grade,
            image_url: item.image_url,
            image_paths: item.image_paths,
            images: item.images,
            image_processing_status: item.image_processing_status,
            notes: sku.notes,
            weight_g: metadata.weight_g,
            stock_qty: item.total_stock_qty,
            total_stock_qty: item.total_stock_qty,
            status: sku.status,
            is_display: item.is_display,
            listing_status: item.listing_status,
            status_label: item.status_label,
            can_restock: item.can_restock,
            created_at: sku.created_at,
            updated_at: sku.updated_at,
            stocks: item.stocks.map(({ stock_qty, ...stock }) => ({ ...stock, qty: stock_qty })),
            print_payload: buildPrintPayload({
              sku_code: sku.sku_code,
              barcode: sku.barcode ?? null,
              name: sku.name,
              price_tier: sku.price_tier,
              grade: sku.grade,
              condition_grade: item.condition_grade,
            }),
          });
        } catch (error) {
          return productReadError(error);
        }
      },
      PATCH: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        if (!UUID_RE.test(params.id)) return errCode("not_found", "SKU not found");
        return handleItemPatch(request, auth.device.id, params.id.toLowerCase());
      },
      DELETE: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        if (!UUID_RE.test(params.id)) return errCode("not_found", "SKU not found");
        return handleItemDelete(request, auth.device.id, params.id.toLowerCase());
      },
    },
  },
});
