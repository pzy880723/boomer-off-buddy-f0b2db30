import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeCourierChoice } from "@/lib/commerce/order-policy";
import { normalizeStorefrontOrderItems } from "@/lib/commerce/storefront-order-request";
import { ordinaryPaymentPolicy } from "@/server/ordinary-payment-config";
import { recordOrderOrigin } from "@/server/order-origin.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import {
  OrderListError,
  listStorefrontOrders,
} from "@/server/storefront-order-list-query.server";

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
    source_platform: z.enum(["miniapp", "app", "web"]).optional(),
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
        try {
          const payload = await listStorefrontOrders({
            client: supabaseAdmin as unknown as { from: (table: string) => unknown },
            customerId: auth.customer.id,
            url: new URL(request.url),
          });
          return storefrontJson(payload);
        } catch (error) {
          if (error instanceof OrderListError) return storefrontError(error.message, error.status);
          return storefrontError(error instanceof Error ? error.message : "Order list failed", 500);
        }
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
        if (!ordinary && body.courier_quote_snapshot?.version === "per_store_99_cross_299_v1") {
          return storefrontError("普通商城结算尚未开放，请稍后重试", 503, "checkout_not_enabled");
        }
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
          if (/zero payable order not supported/i.test(error.message)) {
            return storefrontError("当前支付通道不支持零元订单，请更换优惠券或联系客服", 422, "zero_payable_unsupported");
          }
          if (/coupon unavailable/i.test(error.message)) {
            return storefrontError("优惠券已失效或被其他订单使用，请重新选择", 409, "coupon_unavailable");
          }
          if (/shipping quote changed/i.test(error.message)) {
            return storefrontError("商品金额或运费已变动，请刷新报价后确认", 409, "shipping_quote_changed");
          }
          if (/ordinary express delivery only/i.test(error.message)) {
            return storefrontError("目前仅支持普通快递配送", 422, "delivery_unavailable");
          }
          const conflict = /not available|out of stock|duplicate/i.test(error.message);
          return storefrontError(
            error.message,
            conflict ? 409 : 500,
            conflict ? "stock_conflict" : undefined,
          );
        }
        try {
          await recordOrderOrigin({rpc: (name, args) => supabaseAdmin.rpc(name as never, args as never)}, {
            orderId: (data as unknown as {id: string}).id,
            customerId: auth.customer.id,
            platform: body.source_platform,
          });
        } catch {
          // The order already exists. Retrying the same key replays it, never creates a second order.
          return storefrontError("订单来源记录待重试，请使用原 Idempotency-Key 查询或重试", 503, "order_source_pending");
        }
        return storefrontJson({ ok: true, data }, { status: 201 });
      },
    },
  },
});
