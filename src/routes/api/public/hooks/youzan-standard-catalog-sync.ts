import { createFileRoute } from "@tanstack/react-router";
import {
  assertStandardCatalogSyncHost,
  parseStandardCatalogSyncRequest,
} from "@/lib/standard-catalog-youzan-sync";

type StandardSku = {
  id: string;
  sku_code: string | null;
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
        const { data: shop, error: shopError } = await supabaseAdmin
          .from("youzan_shops")
          .select("*")
          .eq("id", options.shopId)
          .maybeSingle();
        if (shopError || !shop) {
          return Response.json(
            { ok: false, error: shopError?.message ?? "中信泰富有赞门店不存在" },
            { status: 400 },
          );
        }
        if ((shop as { role?: string }).role !== "branch") {
          return Response.json(
            { ok: false, error: "中信泰富目标店铺不是有赞分店" },
            { status: 400 },
          );
        }

        const { data, error, count } = await supabaseAdmin
          .from("inv_skus")
          .select("id, sku_code, name, category, price_tier", { count: "exact" })
          .eq("kind", "single")
          .eq("is_custom_price", false)
          .eq("inventory_policy", "unlimited")
          .eq("is_display", true)
          .order("category", { ascending: true })
          .order("price_tier", { ascending: true })
          .range(options.offset, options.offset + options.limit - 1);
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const skus = (data ?? []) as StandardSku[];
        const nextOffset = options.offset + skus.length;
        const batch = {
          total: count ?? skus.length,
          offset: options.offset,
          limit: options.limit,
          processed: skus.length,
          next_offset: nextOffset,
          has_more: nextOffset < (count ?? skus.length),
        };
        const target = {
          shop_id: options.shopId,
          shop_name: (shop as { shop_name?: string }).shop_name ?? "中信泰富",
          kdt_id: Number((shop as { kdt_id?: number }).kdt_id ?? 0),
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
            items: skus.map((sku) => ({
              ...sku,
              links: (links ?? []).filter((link) => link.sku_id === sku.id),
              listings: (listings ?? []).filter((listing) => listing.sku_id === sku.id),
            })),
            note: "ERP 为无限库存；有赞使用有限镜像库存，默认每次全量覆盖为 9999。",
          });
        }

        const { publishSkuToHqCore, releaseSkuToBranchCore } =
          await import("@/lib/omnichannel-publish.functions");
        const { explainYouzanError, pushYouzanQuantityUpdate } =
          await import("@/lib/youzan.functions");
        const results: Array<Record<string, unknown>> = [];

        for (const sku of skus) {
          try {
            const hq = await publishSkuToHqCore(sku.id);
            const branch = await releaseSkuToBranchCore(sku.id, options.shopId);
            if (!branch.ok || !branch.item_id || !branch.sku_id) {
              throw new Error(branch.error ?? "分店铺货后未获得真实 item_id/sku_id");
            }
            const stock = await pushYouzanQuantityUpdate({
              branchShop: shop as unknown as Parameters<
                typeof pushYouzanQuantityUpdate
              >[0]["branchShop"],
              itemId: branch.item_id,
              skuId: branch.sku_id,
              quantity: options.targetStock,
              hqSpuIdGuard: branch.hq_spu_id ?? undefined,
              channel: 1,
            });
            const pushedAt = new Date().toISOString();
            const [listingUpdate, linkUpdate] = await Promise.all([
              supabaseAdmin
                .from("sku_channel_listings")
                .update({
                  last_stock: options.targetStock,
                  last_stock_pushed: options.targetStock,
                  last_pushed_at: pushedAt,
                  last_error: null,
                  updated_at: pushedAt,
                } as never)
                .eq("sku_id", sku.id)
                .eq("channel", "youzan_branch_offline")
                .eq("shop_id", options.shopId),
              supabaseAdmin
                .from("sku_youzan_links")
                .update({
                  last_pushed_stock: options.targetStock,
                  last_pushed_at: pushedAt,
                  last_error: null,
                  updated_at: pushedAt,
                } as never)
                .eq("sku_id", sku.id)
                .eq("shop_id", options.shopId),
            ]);
            if (listingUpdate.error) throw new Error(listingUpdate.error.message);
            if (linkUpdate.error) throw new Error(linkUpdate.error.message);
            results.push({
              sku_id: sku.id,
              sku_code: sku.sku_code,
              name: sku.name,
              ok: true,
              hq_created: hq.created,
              hq_spu_id: hq.spu_id,
              branch_item_id: branch.item_id,
              branch_sku_id: branch.sku_id,
              target_stock: options.targetStock,
              trace_id: stock.trace_id,
            });
          } catch (error) {
            results.push({
              sku_id: sku.id,
              sku_code: sku.sku_code,
              name: sku.name,
              ok: false,
              error: explainYouzanError(error),
            });
          }
        }

        const failed = results.filter((item) => item.ok === false).length;
        return Response.json({
          ok: failed === 0,
          dry_run: false,
          target,
          batch,
          succeeded: results.length - failed,
          failed,
          results,
        });
      },
    },
  },
});
