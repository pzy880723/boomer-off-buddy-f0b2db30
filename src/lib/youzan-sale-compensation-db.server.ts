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
      // 一次性按 tid 批量读取事件键（分批 50），避免逐单查询拖慢定时任务。
      const out: Record<string, number> = Object.fromEntries(tids.map((t) => [t, 0]));
      for (let i = 0; i < tids.length; i += 50) {
        const part = tids.slice(i, i + 50);
        const { data, error } = await supabaseAdmin.from("inventory_sale_events")
          .select("source_order_id")
          .in("source_channel", ["youzan_branch_offline", "youzan_online"])
          .eq("event_type", "paid")
          .or(part.map((t) => `source_order_id.like.${t}#*`).join(","))
          .limit(5000);
        if (error) throw new Error(`读取销售事件失败：${error.message}`);
        for (const r of (data ?? []) as { source_order_id: string }[]) {
          const tid = r.source_order_id.split("#")[0];
          if (tid in out) out[tid]++;
        }
      }
      return out;
    },
    adapter: createSupabaseYouzanSaleAdapter,
  };
}
