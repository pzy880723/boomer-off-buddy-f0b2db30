import { createFileRoute } from "@tanstack/react-router";
import {
  assertStandardCatalogSyncHost,
  groupStandardCatalogSkus,
  parseStandardCatalogSyncRequest,
  selectStandardCatalogTargetShops,
} from "@/lib/standard-catalog-youzan-sync";

type StandardSku = {
  id: string;
  sku_code: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  price_tier: number;
};

function unauthorized() {
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export const Route = createFileRoute("/api/public/hooks/youzan-standard-catalog-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        const authorization = request.headers.get("authorization") ?? "";
        if (!serviceRoleKey || authorization !== `Bearer ${serviceRoleKey}`) return unauthorized();

        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          // Empty body is a dry-run request.
        }

        let options: ReturnType<typeof parseStandardCatalogSyncRequest>;
        try {
          options = parseStandardCatalogSyncRequest(body);
          assertStandardCatalogSyncHost(new URL(request.url).hostname, options.dryRun);
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: shopRows, error: shopError } = await supabaseAdmin
          .from("youzan_shops")
          .select("id, shop_name, kdt_id, warehouse_code, role, status")
          .eq("role", "branch")
          .eq("status", "active")
          .order("shop_name", { ascending: true });
        if (shopError) {
          return Response.json(
            { ok: false, error: shopError.message },
            { status: 400 },
          );
        }
        const shops = selectStandardCatalogTargetShops(shopRows ?? []);
        if (shops.length === 0) {
          return Response.json(
            { ok: false, error: "没有可同步的启用中有赞分店" },
            { status: 400 },
          );
        }

        const { data, error } = await supabaseAdmin
          .from("inv_skus")
          .select("id, sku_code, barcode, name, category, price_tier")
          .eq("kind", "single")
          .eq("is_custom_price", false)
          .eq("inventory_policy", "unlimited")
          .eq("is_display", true)
          .order("category", { ascending: true })
          .order("name", { ascending: true })
          .order("price_tier", { ascending: true });
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const allGroups = groupStandardCatalogSkus((data ?? []) as StandardSku[]);
        const groups = allGroups.slice(options.offset, options.offset + options.limit);
        const skus = groups.flatMap((group) => group.skus);
        const nextOffset = options.offset + groups.length;
        const batch = {
          total: allGroups.length,
          offset: options.offset,
          limit: options.limit,
          processed: groups.length,
          next_offset: nextOffset,
          has_more: nextOffset < allGroups.length,
        };
        const target = {
          shops: shops.map((shop) => ({
            shop_id: shop.id,
            shop_name: shop.shop_name,
            kdt_id: Number(shop.kdt_id),
          })),
          channel: 1,
          target_stock: options.targetStock,
        };

        if (options.dryRun) {
          const skuIds = skus.map((sku) => sku.id);
          const [{ data: links }, { data: listings }] =
            skuIds.length > 0
              ? await Promise.all([
                  supabaseAdmin
                    .from("sku_youzan_links")
                    .select("sku_id, shop_id, role, yz_item_id, yz_sku_id, status, last_error")
                    .in("sku_id", skuIds),
                  supabaseAdmin
                    .from("sku_channel_listings")
                    .select(
                      "sku_id, channel, shop_id, listing_status, external_spu_id, external_item_id, external_sku_id, last_error",
                    )
                    .in("sku_id", skuIds),
                ])
              : [{ data: [] }, { data: [] }];
          return Response.json({
            ok: true,
            dry_run: true,
            target,
            batch,
            items: groups.map((group) => ({
              group_key: group.key,
              sku_code: group.code,
              name: group.name,
              category: group.category,
              sku_count: group.skus.length,
              price_tiers: group.skus.map((sku) => sku.price_tier),
              skus: group.skus.map((sku) => ({
                ...sku,
                links: (links ?? []).filter((link) => link.sku_id === sku.id),
                listings: (listings ?? []).filter((listing) => listing.sku_id === sku.id),
              })),
            })),
            note: "ERP 为无限库存；有赞使用有限镜像库存，默认每次全量覆盖为 9999。",
          });
        }

        const { syncStandardSkuToYouzanBranchesCore } =
          await import("@/lib/standard-catalog-youzan.server");
        const { explainYouzanError } = await import("@/lib/youzan.functions");
        const results: Array<Record<string, unknown>> = [];

        for (const group of groups) {
          try {
            const synced = await syncStandardSkuToYouzanBranchesCore({
              skuId: group.skus[0].id,
              shops,
              targetStock: options.targetStock,
            });
            results.push({
              group_key: group.key,
              sku_code: group.code,
              name: group.name,
              sku_count: group.skus.length,
              price_tiers: group.skus.map((sku) => sku.price_tier),
              ok: synced.ok,
              hq_created: synced.hq.created,
              hq_spu_id: synced.hq.spu_id,
              branches: synced.branches,
            });
          } catch (error) {
            results.push({
              group_key: group.key,
              sku_code: group.code,
              name: group.name,
              sku_count: group.skus.length,
              price_tiers: group.skus.map((sku) => sku.price_tier),
              ok: false,
              stage: "hq",
              error: explainYouzanError(error),
            });
          }
        }

        const failed = results.filter((item) => item.ok === false).length;
        const failedBranches = results.reduce((total, item) => {
          const branches = Array.isArray(item.branches) ? item.branches : [];
          return total + branches.filter((branch) => branch.ok === false).length;
        }, 0);
        return Response.json({
          ok: failed === 0,
          dry_run: false,
          target,
          batch,
          succeeded: results.length - failed,
          failed,
          failed_branches: failedBranches,
          results,
        });
      },
    },
  },
});
