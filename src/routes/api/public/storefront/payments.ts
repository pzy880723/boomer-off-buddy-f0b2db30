import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  STOREFRONT_CORS,
  authenticateStorefrontCustomer,
  storefrontError,
  storefrontJson,
} from "@/server/storefront-auth.server";
import { storefrontPaymentGatewayConfig } from "@/server/storefront-payment.server";
import {
  StorePaymentNotReadyError,
  buildStorePaymentPlan,
  type StorePaymentProfile,
} from "@/lib/payments/store-payment-plan";

const CreatePaymentBody = z.object({
  order_id: z.string().uuid(),
  provider: z.enum(["wechat", "alipay"]),
  client_context: z
    .object({
      platform: z.enum(["app", "miniapp", "web"]),
      openid: z.string().trim().min(1).max(200).optional(),
      return_url: z.string().url().optional(),
    })
    .default({ platform: "app" }),
});

const GatewayResponse = z.object({
  transaction_id: z.string().trim().min(1).max(200),
  payment_payload: z.record(z.string(), z.unknown()),
  expires_at: z.string().datetime().optional(),
});

export const Route = createFileRoute("/api/public/storefront/payments")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: STOREFRONT_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateStorefrontCustomer(request);
        if (!auth.ok) return auth.response;
        const idempotencyKey = request.headers.get("idempotency-key")?.trim();
        if (!idempotencyKey) return storefrontError("Missing Idempotency-Key", 400);

        let body: z.infer<typeof CreatePaymentBody>;
        try {
          body = CreatePaymentBody.parse(await request.json());
        } catch (error) {
          return storefrontError(`Invalid request: ${String(error)}`, 400);
        }
        if (body.provider !== "wechat") {
          return storefrontError(
            "Store-scoped payment currently supports WeChat Pay only",
            503,
            "provider_not_configured_for_stores",
          );
        }

        const { data: order, error: orderError } = await supabaseAdmin
          .from("commerce_orders" as never)
          .select(
            "id,order_no,customer_id,payment_status,order_status,total_amount,currency,reservation_expires_at",
          )
          .eq("id", body.order_id)
          .eq("customer_id", auth.customer.id)
          .maybeSingle();
        if (orderError) return storefrontError(orderError.message, 500);
        if (!order) return storefrontError("Order not found", 404);
        const orderRow = order as unknown as {
          id: string;
          order_no: string;
          payment_status: string;
          order_status: string;
          total_amount: number;
          currency: string;
          reservation_expires_at: string;
        };
        if (orderRow.payment_status === "paid") {
          return storefrontError("Order is already paid", 409, "already_paid");
        }
        if (
          orderRow.order_status !== "pending_payment" ||
          new Date(orderRow.reservation_expires_at).getTime() <= Date.now()
        ) {
          return storefrontError("Order is no longer payable", 409, "order_not_payable");
        }

        const { data: replay } = await supabaseAdmin
          .from("commerce_payments" as never)
          .select(
            "id,order_id,provider,status,amount,currency,provider_transaction_id,payment_payload,expires_at,created_at",
          )
          .eq("provider", body.provider)
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (replay) {
          const replayRow = replay as unknown as {
            payment_payload: Record<string, unknown>;
            expires_at: string | null;
            [key: string]: unknown;
          };
          const { payment_payload, expires_at, ...payment } = replayRow;
          return storefrontJson({
            ok: true,
            data: {
              payment,
              payment_payload,
              expires_at: expires_at ?? orderRow.reservation_expires_at,
            },
            replayed: true,
          });
        }

        const { data: orderItems, error: itemError } = await supabaseAdmin
          .from("commerce_order_items" as never)
          .select("id,location_id,line_total")
          .eq("order_id", orderRow.id);
        if (itemError) return storefrontError(itemError.message, 500);
        const itemRows = (orderItems ?? []) as unknown as Array<{
          id: string;
          location_id: string;
          line_total: number;
        }>;
        if (itemRows.length === 0) return storefrontError("Order has no items", 409);
        const locationIds = [...new Set(itemRows.map((item) => item.location_id))];
        const { data: profileData, error: profileError } = await supabaseAdmin
          .from("store_payment_profiles" as never)
          .select("id,location_id,subject_id,payment_code,status,is_enabled")
          .in("location_id", locationIds);
        if (profileError) return storefrontError(profileError.message, 500);
        const profileRows = (profileData ?? []) as unknown as Array<{
          id: string;
          location_id: string;
          subject_id: string | null;
          payment_code: string;
          status: StorePaymentProfile["profileStatus"];
          is_enabled: boolean;
        }>;
        const subjectIds = [
          ...new Set(
            profileRows
              .map((profile) => profile.subject_id)
              .filter((id): id is string => Boolean(id)),
          ),
        ];
        const [
          { data: subjectData, error: subjectError },
          { data: locationData, error: locationError },
        ] = await Promise.all([
          subjectIds.length > 0
            ? supabaseAdmin
                .from("payment_subjects" as never)
                .select(
                  "id,legal_name,erp_verification_status,provider_application_status,wechat_sub_mchid",
                )
                .in("id", subjectIds)
            : Promise.resolve({ data: [], error: null }),
          supabaseAdmin.from("inv_locations").select("id,name").in("id", locationIds),
        ]);
        if (subjectError) return storefrontError(subjectError.message, 500);
        if (locationError) return storefrontError(locationError.message, 500);
        const subjects = new Map(
          (
            (subjectData ?? []) as unknown as Array<{
              id: string;
              legal_name: string;
              erp_verification_status: StorePaymentProfile["verificationStatus"];
              provider_application_status: StorePaymentProfile["providerStatus"];
              wechat_sub_mchid: string | null;
            }>
          ).map((subject) => [subject.id, subject]),
        );
        const locations = new Map(
          ((locationData ?? []) as Array<{ id: string; name: string }>).map((location) => [
            location.id,
            location.name,
          ]),
        );
        const profiles: StorePaymentProfile[] = profileRows.flatMap((profile) => {
          if (!profile.subject_id) return [];
          const subject = subjects.get(profile.subject_id);
          return [
            {
              id: profile.id,
              locationId: profile.location_id,
              locationName: locations.get(profile.location_id) ?? "未知门店",
              paymentCode: profile.payment_code,
              profileStatus: profile.is_enabled ? profile.status : "disabled",
              subjectId: profile.subject_id,
              subjectName: subject?.legal_name ?? "未配置主体",
              verificationStatus: subject?.erp_verification_status ?? "draft",
              providerStatus: subject?.provider_application_status ?? "not_applied",
              merchantId: subject?.wechat_sub_mchid ?? null,
            },
          ];
        });
        let paymentPlan;
        try {
          paymentPlan = buildStorePaymentPlan({
            orderId: orderRow.id,
            totalAmount: Number(orderRow.total_amount),
            currency: orderRow.currency,
            items: itemRows.map((item) => ({
              id: item.id,
              locationId: item.location_id,
              lineTotal: Number(item.line_total),
            })),
            profiles,
          });
        } catch (error) {
          if (error instanceof StorePaymentNotReadyError) {
            return storefrontError(
              `Store payment is not ready: ${error.locationIds.join(",")}`,
              409,
              "store_payment_not_ready",
            );
          }
          return storefrontError(error instanceof Error ? error.message : String(error), 409);
        }

        const config = storefrontPaymentGatewayConfig();
        if (!config.configured || !config.url || !config.token) {
          return storefrontError(
            "Payment gateway is not configured",
            503,
            "payment_not_configured",
          );
        }

        const { data: payment, error: paymentError } = await supabaseAdmin
          .from("commerce_payments" as never)
          .insert({
            order_id: orderRow.id,
            provider: body.provider,
            status: "pending",
            amount: Number(orderRow.total_amount),
            currency: orderRow.currency,
            idempotency_key: idempotencyKey,
            payment_payload: {},
            expires_at: orderRow.reservation_expires_at,
          } as never)
          .select("id,order_id,provider,status,amount,currency,provider_transaction_id,created_at")
          .single();
        if (paymentError) return storefrontError(paymentError.message, 500);
        const paymentRow = payment as unknown as { id: string };
        const subOrders = paymentPlan.subOrders.map((subOrder) => ({
          payment_profile_id: subOrder.paymentProfileId,
          settlement_subject_id: subOrder.settlementSubjectId,
          merchant_id: subOrder.merchantId,
          payment_code: subOrder.paymentCode,
          line_amount: subOrder.lineAmount,
          order_adjustment: subOrder.orderAdjustment,
          amount: subOrder.amount,
          currency: orderRow.currency,
          location_ids: subOrder.locationIds,
        }));
        const { error: allocationError } = await supabaseAdmin.rpc(
          "commerce_capture_payment_allocation" as never,
          {
            p_order_id: orderRow.id,
            p_payment_id: paymentRow.id,
            p_item_snapshots: paymentPlan.itemSnapshots.map((item) => ({
              order_item_id: item.orderItemId,
              settlement_subject_id: item.settlementSubjectId,
              snapshot: item.snapshot,
            })),
            p_suborders: subOrders,
          } as never,
        );
        if (allocationError) {
          await supabaseAdmin
            .from("commerce_payments" as never)
            .delete()
            .eq("id", paymentRow.id);
          return storefrontError(allocationError.message, 409, "store_payment_not_ready");
        }
        const markGatewayFailed = async (failureCode: string, failureMessage: string) => {
          await Promise.all([
            supabaseAdmin
              .from("commerce_payments" as never)
              .update({
                status: "failed",
                failure_code: failureCode,
                failure_message: failureMessage,
                updated_at: new Date().toISOString(),
              } as never)
              .eq("id", paymentRow.id),
            supabaseAdmin
              .from("commerce_payment_suborders" as never)
              .update({ status: "failed", updated_at: new Date().toISOString() } as never)
              .eq("payment_id", paymentRow.id),
          ]);
        };

        const callbackUrl = `${new URL(request.url).origin}/api/public/storefront/payments/callback/${body.provider}`;
        let gatewayResponse: Response;
        try {
          gatewayResponse = await fetch(`${config.url}/v1/payments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.token}`,
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              provider: body.provider,
              merchant_order_no: orderRow.order_no,
              amount: Number(orderRow.total_amount),
              currency: orderRow.currency,
              description: `BOOMER OFF ${orderRow.order_no}`,
              notify_url: callbackUrl,
              client_context: body.client_context,
              sub_orders: subOrders.map((subOrder, index) => ({
                merchant_order_no: `${orderRow.order_no}-${String(index + 1).padStart(2, "0")}`,
                merchant_id: subOrder.merchant_id,
                amount: subOrder.amount,
                currency: subOrder.currency,
                payment_code: subOrder.payment_code,
                location_ids: subOrder.location_ids,
              })),
            }),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await markGatewayFailed("gateway_unreachable", message);
          return storefrontError("Payment gateway unavailable", 502, "payment_gateway_error");
        }
        if (!gatewayResponse.ok) {
          await markGatewayFailed("gateway_error", `HTTP ${gatewayResponse.status}`);
          return storefrontError(
            `Payment gateway unavailable (HTTP ${gatewayResponse.status})`,
            502,
            "payment_gateway_error",
          );
        }
        let gateway;
        try {
          gateway = GatewayResponse.parse(await gatewayResponse.json());
        } catch (error) {
          await markGatewayFailed("invalid_gateway_response", String(error));
          return storefrontError(`Invalid payment gateway response: ${String(error)}`, 502);
        }

        const { data: updatedPayment, error: updatePaymentError } = await supabaseAdmin
          .from("commerce_payments" as never)
          .update({
            status: "processing",
            provider_transaction_id: gateway.transaction_id,
            payment_payload: gateway.payment_payload,
            expires_at: gateway.expires_at ?? orderRow.reservation_expires_at,
            updated_at: new Date().toISOString(),
          } as never)
          .eq("id", paymentRow.id)
          .select("id,order_id,provider,status,amount,currency,provider_transaction_id,created_at")
          .single();
        if (updatePaymentError) return storefrontError(updatePaymentError.message, 500);
        await supabaseAdmin
          .from("commerce_payment_suborders" as never)
          .update({ status: "processing" } as never)
          .eq("payment_id", paymentRow.id);
        return storefrontJson(
          {
            ok: true,
            data: {
              payment: updatedPayment,
              payment_payload: gateway.payment_payload,
              sub_orders: subOrders,
              expires_at: gateway.expires_at ?? orderRow.reservation_expires_at,
            },
          },
          { status: 201 },
        );
      },
    },
  },
});
