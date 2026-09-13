import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeCourierChoice } from "@/lib/commerce/order-policy";
import { normalizeStorefrontOrderItems } from "@/lib/commerce/storefront-order-request";
import { ordinaryPaymentPolicy } from "@/server/ordinary-payment-config";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";

const CreateOrderBody = z
  .object({
    items: z
      .array(
        z.object({
          listing_id: z.string().uuid(),
          quantity: z.number().int().min(1).max(999),
        }),
      )
      .min(1)
      .max(50)
      .optional(),
    listing_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
    recipient_name: z.string().trim().min(1).max(80),
    recipient_phone: z.string().trim().min(6).max(30),
    shipping_address: z.record(z.string(), z.unknown()),
    courier_service_code: z.string().trim().min(1).max(80),
    courier_service_name: z.string().trim().max(120).optional(),
    shipping_fee: z.number().min(0).max(100000).default(0),
    courier_quote_snapshot: z.record(z.string(), z.unknown()).optional(),
    customer_note: z.string().trim().max(500).optional(),
  })
  .refine((body) => body.items || body.listing_ids, {
    message: "items or listing_ids is required",
  });

export const Route = createFileRoute("/api/public/storefront/orders")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;

        let query: OrdersListQuery;
        try {
          query = parseOrdersListQuery(new URL(request.url));
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : "Invalid query", 400);
        }

        const coarse = coarseStatusFilter(query.status);
        let fetchError: string | null = null;

        // 键集分页：created_at desc, id desc；游标值已在 parse 阶段校验（ISO 时间 + UUID）。
        const fetchBatch = async ({
          cursor,
          size,
        }: {
          cursor: { created_at: string; id: string } | null;
          size: number;
        }) => {
          let builder = supabaseAdmin
            .from("commerce_orders" as never)
            .select(
              [
                "id, order_no, order_status, payment_status, total_amount, shipping_fee, discount_total, currency, created_at, courier_quote_snapshot",
                "items:commerce_order_items(id, location_id, title_snapshot, image_snapshot, unit_price, quantity, line_total, listing_id, listing:commerce_listings(image_paths, cover_url))",
                "fulfillments(location_id, status)",
              ].join(", "),
            )
            .eq("customer_id", auth.customer.id);
          if (coarse.orderStatuses) builder = builder.in("order_status", coarse.orderStatuses);
          if (coarse.paymentStatuses) builder = builder.in("payment_status", coarse.paymentStatuses);
          if (cursor) {
            builder = builder.or(
              `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
            );
          }
          const { data, error } = await builder
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(size);
          if (error) {
            fetchError = error.message;
            return [];
          }
          return (data ?? []) as unknown as OrderRow[];
        };

        const page = await selectOrdersPage(fetchBatch, query);
        if (fetchError) return storefrontError(fetchError, 500);

        // 门店信息：整页一次批量查询（不做逐单详情 N+1）
        const locationIds = Array.from(
          new Set(
            page.rows.flatMap((row) =>
              (row.items ?? []).map((item) => item.location_id).filter((id): id is string => !!id),
            ),
          ),
        );
        const storeMap = new Map<string, StoreInfo>();
        if (locationIds.length > 0) {
          const { data: locations, error: locationError } = await supabaseAdmin
            .from("inv_locations" as never)
            .select("id, name, shop:youzan_shops(id, shop_name)")
            .in("id", locationIds);
          if (locationError) return storefrontError(locationError.message, 500);
          for (const row of (locations ?? []) as unknown as Array<{
            id: string;
            name: string | null;
            shop: { id: string | null; shop_name: string | null } | null;
          }>) {
            storeMap.set(row.id, {
              store_id: row.shop?.id ?? null,
              store_name: row.shop?.shop_name ?? row.name ?? null,
            });
          }
        }

        // 图片：整页拍平去重后一次批量签名（缩略图优先，失败回退原图签名）
        const { refs, paths } = collectImageRefs(page.rows);
        let signed: (string | null)[] = [];
        if (paths.length > 0) {
          const { signSkuImagePaths, signSkuThumbnailPaths } = await import(
            "@/lib/sku-image-resolver.server"
          );
          let thumbs: (string | null)[] = [];
          try {
            thumbs = await signSkuThumbnailPaths(paths);
          } catch {
            thumbs = [];
          }
          let originals: (string | null)[] = [];
          if (thumbs.length !== paths.length || thumbs.some((url) => !url)) {
            try {
              originals = await signSkuImagePaths(paths);
            } catch {
              originals = [];
            }
          }
          signed = paths.map((_, i) => thumbs[i] ?? originals[i] ?? null);
        }
        const images = buildImageMap(refs, paths, signed);

        const data = page.rows.map((row) => buildOrderListItem(row, { stores: storeMap, images }));
        return storefrontJson({
          ok: true,
          data,
          has_more: page.hasMore,
          next_cursor: page.nextCursor,
        });
      },
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const idempotencyKey = request.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) return storefrontError("Missing Idempotency-Key", 400);
        let body: z.infer<typeof CreateOrderBody>;
        try {
          body = CreateOrderBody.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid request: ${String(error)}`, 400);
        }
        let items;
        try {
          items = normalizeStorefrontOrderItems(body);
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 400);
        }
        let courier;
        try {
          courier = normalizeCourierChoice(body.courier_service_code);
        } catch (error) {
          return storefrontError(error instanceof Error ? error.message : String(error), 422);
        }
        let paymentPolicy;
        try { paymentPolicy = ordinaryPaymentPolicy(process.env); }
        catch { return storefrontError("支付配置暂不可用", 503); }
        const ordinary = paymentPolicy.mode === "ordinary_wechat";
        const { data, error } = await supabaseAdmin.rpc(
          (ordinary ? "commerce_create_ordinary_order" : "commerce_create_order_v2") as never,
          {
            ...(paymentPolicy.mode === "ordinary_wechat" ? {
              p_customer_id: auth.customer.id,
              p_merchant_id: paymentPolicy.merchantId, p_app_id: paymentPolicy.appId,
              p_owned_location_ids: paymentPolicy.ownedLocationIds,
            } : { p_user_id: auth.customer.id }),
            p_idempotency_key: idempotencyKey,
            p_items: items,
            p_recipient_name: body.recipient_name,
            p_recipient_phone: body.recipient_phone,
            p_shipping_address: body.shipping_address,
            p_courier_provider: courier.provider,
            p_courier_service_code: courier.serviceCode,
            p_courier_service_name: body.courier_service_name ?? null,
            p_shipping_fee: body.shipping_fee,
            p_quote_snapshot: body.courier_quote_snapshot ?? null,
            p_customer_note: body.customer_note ?? null,
          } as never,
        );
        if (error) {
          const conflict = /not available|out of stock|duplicate/i.test(error.message);
          return storefrontError(
            error.message,
            conflict ? 409 : 500,
            conflict ? "stock_conflict" : undefined,
          );
        }
        return storefrontJson({ ok: true, data }, { status: 201 });
      },
    },
  },
});
