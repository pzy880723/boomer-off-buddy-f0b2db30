// 补偿作业真实依赖：只读 youzan_orders / inventory_sale_events / inv_skus / inv_stocks / inv_stock_movements，
// 扣减只走 commit_youzan_sale_line。
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createSupabaseYouzanSaleAdapter } from "./youzan-sale.functions";
import type { CompensationDeps, SkuMeta } from "./youzan-sale-compensation.server";

const SALE_STATUSES = ["TRADE_PAID", "TRADE_SUCCESS", "WAIT_SELLER_SEND_GOODS", "WAIT_BUYER_CONFIRM_GOODS"];
const SAFE_TID = /^[A-Za-z0-9_-]+$/;

export function compensationDeps(): CompensationDeps {
  return {
    listOrdersPage: async ({ since, limit, after, tids }) => {
      let q = supabaseAdmin.from("youzan_orders")
        .select("tid,shop_id,status,pay_time,raw")
        .gte("pay_time", since).in("status", SALE_STATUSES)
        .not("shop_id", "is", null)
        .order("pay_time", { ascending: true }).order("tid", { ascending: true }).limit(limit);
      if (after) {
        if (!SAFE_TID.test(after.tid)) throw new Error("非法分页游标");
        q = q.or(`pay_time.gt.${after.pay_time},and(pay_time.eq.${after.pay_time},tid.gt.${after.tid})`);
      }
      if (tids?.length) q = q.in("tid", tids);
      const { data, error } = await q;
      if (error) throw new Error(`读取近期订单失败：${error.message}`);
      return (data ?? []) as never;
    },
    processedKeys: async (tids) => {
      const out = new Set<string>();
      for (let i = 0; i < tids.length; i += 50) {
        const part = tids.slice(i, i + 50).filter((t) => SAFE_TID.test(t));
        if (!part.length) continue;
        const { data, error } = await supabaseAdmin.from("inventory_sale_events")
          .select("source_order_id")
          .in("source_channel", ["youzan_branch_offline", "youzan_online"])
          .eq("event_type", "paid").eq("status", "processed")
          .or(part.map((t) => `source_order_id.like.${t}#*`).join(","))
          .limit(5000);
        if (error) throw new Error(`读取销售事件失败：${error.message}`);
        for (const r of (data ?? []) as { source_order_id: string }[]) out.add(r.source_order_id);
      }
      return out;
    },
    skuMeta: async (ids) => {
      const { data, error } = await supabaseAdmin.from("inv_skus")
        .select("id,sku_scope,kind,inventory_policy,sales_state").in("id", ids);
      if (error) throw new Error(`读取商品类型失败：${error.message}`);
      return new Map(((data ?? []) as Array<{ id: string; sku_scope: string | null; kind: string | null; inventory_policy: string | null; sales_state: string | null }>)
        .map((r) => [r.id, { scope: r.sku_scope, kind: r.kind, policy: r.inventory_policy, salesState: r.sales_state } satisfies SkuMeta]));
    },
    locationQty: async (skuId, locationId) => {
      const { data, error } = await supabaseAdmin.from("inv_stocks").select("qty")
        .eq("sku_id", skuId).eq("location_id", locationId).maybeSingle();
      if (error) throw new Error(`读取门店库存失败：${error.message}`);
      return Number(data?.qty ?? 0);
    },
    restockedAfter: async (skuId, locationId, since) => {
      const { data, error } = await supabaseAdmin.from("inv_stock_movements").select("id")
        .eq("sku_id", skuId).eq("location_id", locationId).gt("delta", 0).gt("created_at", since).limit(1);
      if (error) throw new Error(`读取库存流水失败：${error.message}`);
      return (data ?? []).length > 0;
    },
    adapter: createSupabaseYouzanSaleAdapter,
  };
}
