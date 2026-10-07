// 补偿作业真实依赖：只读 youzan_orders / inventory_sale_events，扣减只走 commit_youzan_sale_line。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createSupabaseYouzanSaleAdapter } from "./youzan-sale.functions";
import type { CompensationDeps } from "./youzan-sale-compensation.server";

const SALE_STATUSES = ["TRADE_PAID", "TRADE_SUCCESS", "WAIT_SELLER_SEND_GOODS", "WAIT_BUYER_CONFIRM_GOODS"];

export function compensationDeps(): CompensationDeps {
  return {
    listOrders: async ({ since, limit }) => {
      const { data, error } = await supabaseAdmin.from("youzan_orders")
        .select("tid,shop_id,status,pay_time,raw")
        .gte("pay_time", since).in("status", SALE_STATUSES)
        .not("shop_id", "is", null)
        .order("pay_time", { ascending: true }).limit(limit);
      if (error) throw new Error(`读取近期订单失败：${error.message}`);
      return (data ?? []) as never;
    },
    committedUnits: async (tids) => {
      const out: Record<string, number> = {};
      for (const tid of tids) {
        const { count, error } = await supabaseAdmin.from("inventory_sale_events")
          .select("id", { count: "exact", head: true })
          .in("source_channel", ["youzan_branch_offline", "youzan_online"])
          .eq("event_type", "paid").like("source_order_id", `${tid}#%`);
        if (error) throw new Error(`读取销售事件失败：${error.message}`);
        out[tid] = count ?? 0;
      }
      return out;
    },
    adapter: createSupabaseYouzanSaleAdapter,
  };
}
