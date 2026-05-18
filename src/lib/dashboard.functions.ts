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

  // 拉日本小包裹
  const { data: jpRows, error: jpErr } = await supabase
    .from("japan_parcels")
    .select("grand_total_cny,total_cny,purchased_at,created_at,deleted_at")
    .is("deleted_at", null);
  if (jpErr) throw new Error(jpErr.message);

  // 拉国内小包
  const { data: dmRows, error: dmErr } = await supabase
    .from("domestic_orders")
    .select("total_cny,purchased_at,created_at,deleted_at")
    .is("deleted_at", null);
  if (dmErr) throw new Error(dmErr.message);

  const trendMap = new Map<string, { japan_parcel: number; japan_bulk: number; domestic: number }>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(trendStart.getFullYear(), trendStart.getMonth() + i, 1);
    trendMap.set(monthKey(d), { japan_parcel: 0, japan_bulk: 0, domestic: 0 });
  }

  function aggregate(
    rows: Array<{ purchased_at?: string | null; created_at?: string | null }>,
    amountFn: (r: any) => number,
    channel: "japan_parcel" | "domestic",
  ) {
    let month = 0, ytd = 0, all = 0;
    for (const r of rows ?? []) {
      const amt = amountFn(r) || 0;
      const ts = r.purchased_at || r.created_at;
      if (!ts) continue;
      const d = new Date(ts);
      all += amt;
      if (d >= new Date(yearStart)) ytd += amt;
      if (d >= new Date(monthStart)) month += amt;
      const k = monthKey(d);
      if (trendMap.has(k)) trendMap.get(k)![channel] += amt;
    }
    return { month, ytd, all, count: rows?.length ?? 0 };
  }

  const jpStat = aggregate(
    jpRows ?? [],
    (r) => Number(r.grand_total_cny ?? r.total_cny ?? 0),
    "japan_parcel",
  );
  const dmStat = aggregate(
    dmRows ?? [],
    (r) => Number(r.total_cny ?? 0),
    "domestic",
  );
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
