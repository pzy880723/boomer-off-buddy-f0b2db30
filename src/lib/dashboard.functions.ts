import { createServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";

export type ChannelKey = "japan_parcel" | "japan_bulk" | "domestic";

export type PurchaseStats = {
  totals: { month: number; ytd: number; all: number; count: number };
  byChannel: {
    key: ChannelKey;
    label: string;
    month: number;
    ytd: number;
    all: number;
    count: number;
    placeholder?: boolean;
  }[];
  monthlyTrend: { month: string; japan_parcel: number; japan_bulk: number; domestic: number }[];
};

const CHANNEL_LABEL: Record<ChannelKey, string> = {
  japan_parcel: "日本小包裹",
  japan_bulk: "日本大宗",
  domestic: "国内小包",
};

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const getPurchaseStats = createServerFn({ method: "GET" }).handler(async (): Promise<PurchaseStats> => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();

  // 近 12 个月趋势的起点
  const trendStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  // 日本小包裹：按 item.pay_at + item_total_cny 统计，单数按父包裹去重
  const { data: jpItems, error: jpErr } = await supabase
    .from("japan_parcel_items")
    .select("parent_id,pay_at,item_total_cny,japan_parcels!inner(deleted_at)")
    .not("pay_at", "is", null)
    .is("japan_parcels.deleted_at", null);
  if (jpErr) throw new Error(jpErr.message);

  // 国内小包：严格按 purchased_at
  const { data: dmRows, error: dmErr } = await supabase
    .from("domestic_orders")
    .select("total_cny,purchased_at,deleted_at")
    .is("deleted_at", null)
    .not("purchased_at", "is", null);
  if (dmErr) throw new Error(dmErr.message);

  const trendMap = new Map<string, { japan_parcel: number; japan_bulk: number; domestic: number }>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(trendStart.getFullYear(), trendStart.getMonth() + i, 1);
    trendMap.set(monthKey(d), { japan_parcel: 0, japan_bulk: 0, domestic: 0 });
  }

  const monthStartD = new Date(monthStart);
  const yearStartD = new Date(yearStart);

  function bucket(ts: string, amt: number, channel: "japan_parcel" | "domestic") {
    const d = new Date(ts);
    const k = monthKey(d);
    if (trendMap.has(k)) trendMap.get(k)![channel] += amt;
    const inYear = d >= yearStartD;
    const inMonth = d >= monthStartD;
    return { all: amt, ytd: inYear ? amt : 0, month: inMonth ? amt : 0 };
  }

  const jpParents = new Set<string>();
  const jpStat = { month: 0, ytd: 0, all: 0, count: 0 };
  for (const r of jpItems ?? []) {
    const amt = Number(r.item_total_cny ?? 0);
    if (!r.pay_at) continue;
    const b = bucket(r.pay_at as string, amt, "japan_parcel");
    jpStat.all += b.all;
    jpStat.ytd += b.ytd;
    jpStat.month += b.month;
    if (r.parent_id) jpParents.add(r.parent_id as string);
  }
  jpStat.count = jpParents.size;

  const dmStat = { month: 0, ytd: 0, all: 0, count: dmRows?.length ?? 0 };
  for (const r of dmRows ?? []) {
    const amt = Number(r.total_cny ?? 0);
    if (!r.purchased_at) continue;
    const b = bucket(r.purchased_at as string, amt, "domestic");
    dmStat.all += b.all;
    dmStat.ytd += b.ytd;
    dmStat.month += b.month;
  }

  const bulkStat = { month: 0, ytd: 0, all: 0, count: 0 };


  const byChannel = [
    { key: "japan_parcel" as const, label: CHANNEL_LABEL.japan_parcel, ...jpStat },
    { key: "japan_bulk" as const, label: CHANNEL_LABEL.japan_bulk, ...bulkStat, placeholder: true },
    { key: "domestic" as const, label: CHANNEL_LABEL.domestic, ...dmStat },
  ];

  const monthlyTrend = Array.from(trendMap.entries()).map(([month, v]) => ({ month, ...v }));

  return {
    totals: {
      month: jpStat.month + dmStat.month,
      ytd: jpStat.ytd + dmStat.ytd,
      all: jpStat.all + dmStat.all,
      count: jpStat.count + dmStat.count,
    },
    byChannel,
    monthlyTrend,
  };
});
