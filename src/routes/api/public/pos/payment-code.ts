import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/payment-code")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const locationId = new URL(request.url).searchParams.get("location_id")?.trim();
        if (!locationId) return posError("缺少 location_id", 400, "location_required");
        const auth = await authenticatePosUser(request, locationId);
        if (!auth.ok) return auth.response;

        const { data: profile, error } = await supabaseAdmin
          .from("store_payment_profiles" as never)
          .select("id,subject_id,payment_code,status,is_enabled")
          .eq("location_id", locationId)
          .maybeSingle();
        if (error) return posError(error.message, 500);
        if (!profile) {
          return posJson({
            ok: true,
            data: {
              location_id: locationId,
              payment_code: null,
              ready_for_payment: false,
              status: "setup_required",
              message: "该门店尚未在 ERP 配置支付主体",
            },
          });
        }
        const profileRow = profile as unknown as {
          id: string;
          subject_id: string | null;
          payment_code: string;
          status: string;
          is_enabled: boolean;
        };
        const { data: subject, error: subjectError } = profileRow.subject_id
          ? await supabaseAdmin
              .from("payment_subjects" as never)
              .select(
                "legal_name,erp_verification_status,provider_application_status,wechat_sub_mchid,wechat_appid",
              )
              .eq("id", profileRow.subject_id)
              .maybeSingle()
          : { data: null, error: null };
        if (subjectError) return posError(subjectError.message, 500);
        const subjectRow = subject as unknown as {
          legal_name: string;
          erp_verification_status: string;
          provider_application_status: string;
          wechat_sub_mchid: string | null;
          wechat_appid: string | null;
        } | null;
        const readyForPayment = Boolean(
          profileRow.is_enabled &&
          profileRow.status === "active" &&
          subjectRow?.erp_verification_status === "approved" &&
          subjectRow.provider_application_status === "active" &&
          subjectRow.wechat_sub_mchid &&
          subjectRow.wechat_appid,
        );
        return posJson({
          ok: true,
          data: {
            location_id: locationId,
            payment_profile_id: profileRow.id,
            payment_code: profileRow.payment_code,
            qr_mode: "dynamic_order",
            status: profileRow.status,
            subject_name: subjectRow?.legal_name ?? null,
            erp_verification_status: subjectRow?.erp_verification_status ?? "draft",
            provider_application_status: subjectRow?.provider_application_status ?? "not_applied",
            merchant_id_masked: subjectRow?.wechat_sub_mchid
              ? `****${subjectRow.wechat_sub_mchid.slice(-4)}`
              : null,
            ready_for_payment: readyForPayment,
            message: readyForPayment
              ? "门店支付已就绪，收款时请生成订单专属二维码"
              : "门店支付尚未完成主体认证或微信商户开通",
          },
        });
      },
    },
  },
});
