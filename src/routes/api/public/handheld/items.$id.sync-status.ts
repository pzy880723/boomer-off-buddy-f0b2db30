import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/items/$id/sync-status")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const skuId = params.id;
        if (!skuId) return err("Missing sku id", 400);

        const { data: links } = await supabaseAdmin
          .from("sku_youzan_links")
          .select(
            "shop_id, yz_item_id, last_pushed_stock, last_pushed_at, status, last_error, shop:youzan_shops!shop_id(shop_name)",
          )
          .eq("sku_id", skuId);

        const { data: queue } = await supabaseAdmin
          .from("youzan_stock_sync_queue")
          .select("target_stock, status, attempts, next_run_at, last_error, created_at")
          .eq("sku_id", skuId)
          .order("created_at", { ascending: false })
          .limit(10);

        return ok({
          sku_id: skuId,
          links: (links ?? []).map((l: Record<string, unknown>) => ({
            shop_id: l.shop_id as string,
            shop_name: (l.shop as { shop_name?: string } | null)?.shop_name ?? null,
            yz_item_id: (l.yz_item_id as number | null) ?? null,
            last_pushed_stock: (l.last_pushed_stock as number | null) ?? null,
            last_pushed_at: (l.last_pushed_at as string | null) ?? null,
            status: (l.status as string) ?? "",
            last_error: (l.last_error as string | null) ?? null,
          })),
          queue: queue ?? [],
        });
      },
    },
  },
});
