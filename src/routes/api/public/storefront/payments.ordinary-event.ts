import { createFileRoute } from "@tanstack/react-router";
import { ordinaryMerchantConfig } from "@/server/ordinary-payment-config";
import { ordinaryGatewayConfig } from "@/server/ordinary-gateway-config";
import {
  OrdinaryGatewayEvent,
  toDecodedNotification,
  verifyGatewayEventSignature,
} from "@/server/ordinary-gateway-event";
import { ordinaryStore, readNotificationBody } from "@/server/ordinary-payment.server";
import { applyOrdinaryNotification } from "@/server/ordinary-payment-notifications";

/**
 * 腾讯云网关 → ERP 的可信内部支付事件入口。
 * 微信原始回调（RSA 验签 + APIv3 解密）由网关负责，这里只接受网关签名的内部事件，
 * 并再次比对持久化的订单/商户/AppID/币种/金额/openid，入账走幂等 RPC。
 */
export const Route = createFileRoute("/api/public/storefront/payments/ordinary-event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let gateway: ReturnType<typeof ordinaryGatewayConfig>;
        let merchant: ReturnType<typeof ordinaryMerchantConfig>;
        try {
          gateway = ordinaryGatewayConfig(process.env);
          merchant = ordinaryMerchantConfig(process.env);
        } catch {
          return Response.json(
            { code: "FAIL", message: "Gateway not configured" },
            { status: 503 },
          );
        }
        if (!gateway)
          return Response.json(
            { code: "FAIL", message: "Gateway not configured" },
            { status: 503 },
          );

        let raw: string;
        try {
          raw = await readNotificationBody(request);
        } catch {
          return Response.json({ code: "FAIL", message: "Invalid event" }, { status: 400 });
        }
        const verified = verifyGatewayEventSignature({
          rawBody: raw,
          timestamp: request.headers.get("X-Gateway-Timestamp"),
          signature: request.headers.get("X-Gateway-Signature"),
          secret: gateway.eventSecret,
        });
        if (!verified) return Response.json({ code: "FAIL", message: "Rejected" }, { status: 401 });

        try {
          const event = OrdinaryGatewayEvent.parse(JSON.parse(raw));
          const decoded = toDecodedNotification(event, {
            merchantId: merchant.merchantId,
            appId: merchant.appId,
          });
          await applyOrdinaryNotification(ordinaryStore, decoded);
          return new Response(null, { status: 204 });
        } catch {
          // 事务未提交前绝不确认；同时不回显解密后的支付细节。
          return Response.json({ code: "FAIL", message: "Event not accepted" }, { status: 503 });
        }
      },
    },
  },
});
