import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/customers/$id/benefits")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request, params }) => {
        const auth = await authenticatePosUser(request);
        if (!auth.ok) return auth.response;
        const [{ data: customer, error: customerError }, { data: wallet, error: walletError }] =
          await Promise.all([
            supabaseAdmin
              .from("commerce_customers" as never)
              .select("id,phone,nickname,avatar_url,status")
              .eq("id", params.id)
              .maybeSingle(),
            supabaseAdmin
              .from("pos_customer_wallets" as never)
              .select("customer_id,points,store_credit,member_level")
              .eq("customer_id", params.id)
              .maybeSingle(),
          ]);
        if (customerError) return posError(customerError.message, 500);
        if (walletError) return posError(walletError.message, 500);
        if (!customer) return posError("会员不存在", 404, "customer_not_found");

        const now = new Date().toISOString();
        const { data: coupons, error: couponError } = await supabaseAdmin
          .from("pos_customer_coupons" as never)
          .select("id,code,name,discount_type,value,min_spend,starts_at,expires_at")
          .eq("customer_id", params.id)
          .eq("status", "active")
          .or(`starts_at.is.null,starts_at.lte.${now}`)
          .or(`expires_at.is.null,expires_at.gt.${now}`)
          .order("expires_at", { ascending: true, nullsFirst: false });
        if (couponError) return posError(couponError.message, 500);
        return posJson({
          ok: true,
          data: {
            customer,
            wallet: wallet ?? {
              customer_id: params.id,
              points: 0,
              store_credit: 0,
              member_level: "普通会员",
            },
            coupons: coupons ?? [],
          },
        });
      },
    },
  },
});
