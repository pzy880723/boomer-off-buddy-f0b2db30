import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { POS_CORS, authenticatePosUser, posError, posJson } from "@/server/pos-auth.server";

export const Route = createFileRoute("/api/public/pos/customers/search")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: POS_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticatePosUser(request);
        if (!auth.ok) return auth.response;
        const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
        if (query.length < 2) return posError("请输入至少 2 位手机号或会员名称", 400);
        const escaped = query.replace(/[%_,()]/g, " ");
        const { data, error } = await supabaseAdmin
          .from("commerce_customers" as never)
          .select("id,phone,nickname,avatar_url,status")
          .eq("status", "active")
          .or(`phone.ilike.%${escaped}%,nickname.ilike.%${escaped}%`)
          .limit(20);
        if (error) return posError(error.message, 500);

        const customers = (data ?? []) as unknown as Array<{
          id: string;
          phone: string | null;
          nickname: string | null;
          avatar_url: string | null;
          status: string;
        }>;
        const ids = customers.map((customer) => customer.id);
        const { data: wallets, error: walletError } =
          ids.length === 0
            ? { data: [], error: null }
            : await supabaseAdmin
                .from("pos_customer_wallets" as never)
                .select("customer_id,points,store_credit,member_level")
                .in("customer_id", ids);
        if (walletError) return posError(walletError.message, 500);
        // 列表只读已存有赞投影（不逐个实时请求有赞）；未同步显示 null，不用本地积分或 0 代替。
        const { data: projections, error: projectionError } =
          ids.length === 0
            ? { data: [], error: null }
            : await supabaseAdmin
                .from("youzan_points_projection")
                .select("customer_id,balance,balance_synced_at")
                .in("customer_id", ids);
        if (projectionError) return posError("积分同步状态暂不可用", 500);
        const youzanMap = new Map(
          (projections ?? []).filter((p) => p.balance_synced_at && p.balance != null)
            .map((p) => [p.customer_id, Number(p.balance)]),
        );
        const walletMap = new Map(
          (
            (wallets ?? []) as unknown as Array<{
              customer_id: string;
              points: number;
              store_credit: number;
              member_level: string;
            }>
          ).map((wallet) => [wallet.customer_id, wallet]),
        );
        return posJson({
          ok: true,
          data: {
            items: customers.map((customer) => ({
              ...customer,
              wallet: {
                ...(walletMap.get(customer.id) ?? { store_credit: 0, member_level: "普通会员" }),
                points: youzanMap.get(customer.id) ?? null,
                points_source: "youzan",
              },
            })),
          },
        });
      },
    },
  },
});
