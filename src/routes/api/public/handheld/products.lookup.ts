// GET /api/public/handheld/products/lookup?code=<barcode|sku_code|epc|qr_payload>
import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import {
  authorizeProductScope,
  loadProductInventory,
  loadScopedProductSkus,
  filterProductSearch,
  buildProductItems,
  signProductItems,
  productReadError,
} from "@/server/handheld-products.server";

function normalizeCode(input: string): string {
  const s = input.trim();
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s);
      return String(obj.epc || obj.barcode || obj.sku_code || obj.code || "").trim();
    } catch {
      /* A non-JSON scan can still be a barcode. */
    }
  }
  return s;
}

export const Route = createFileRoute("/api/public/handheld/products/lookup")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          const scoped = await authorizeProductScope(request, auth.device);
          const params = new URL(request.url).searchParams;
          const code = normalizeCode(params.get("code") || "");
          const keyword = (params.get("q") || "").trim();
          if (!code && !keyword) return err("Missing code", 400, { code: "missing_code" });
          const inventory = await loadProductInventory(scoped);
          let skus = [] as Awaited<ReturnType<typeof loadScopedProductSkus>>;
          if (code) {
            for (const column of ["barcode", "sku_code", "epc"] as const) {
              skus = await loadScopedProductSkus(inventory, (query) => query.eq(column, code));
              if (skus.length > 0) break;
            }
          } else {
            skus = await loadScopedProductSkus(inventory, (query) =>
              filterProductSearch(query, keyword),
            );
          }
          skus.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
          if (skus.length === 0) return err("Product not found", 404, { code: "not_found" });
          const [item] = await signProductItems(buildProductItems(skus.slice(0, 1), inventory));
          return ok({ ...item, scope: scoped.scope });
        } catch (error) {
          return productReadError(error);
        }
      },
    },
  },
});
