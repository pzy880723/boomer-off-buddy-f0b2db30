import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ChannelKey = "japan_parcel" | "japan_bulk" | "domestic" | "domestic_bulk";

export type ChannelStat = {
  key: ChannelKey;
  label: string;
  month: number;
  ytd: number;
  all: number;
  count: number;
  placeholder?: boolean;
};

export type StatusBucket = { key: string; label: string; count: number };

export type RecentItem = {
  id: string;
  channel: ChannelKey;
  title: string;
  amount: number;
  ts: string;
  status?: string | null;
};

export type PurchaseStats = {
  totals: { month: number; ytd: number; all: number; count: number; monthCount: number };
  byChannel: ChannelStat[];
  monthlyTrend: {
    month: string;
    japan_parcel: number;
    japan_bulk: number;
    domestic: number;
    domestic_bulk: number;
  }[];
  byStatus: StatusBucket[];
  recent: RecentItem[];
};

const CHANNEL_LABEL: Record<ChannelKey, string> = {
  japan_parcel: "日本小包",
  japan_bulk: "日本大宗",
  domestic: "国内小包",
  domestic_bulk: "国内大宗",
};

const JP_STATUS_LABEL: Record<string, string> = {
  purchased: "已采购",
  at_jp_warehouse: "在日仓",
  shipping_intl: "国际运输",
  delivered: "已签收",
  completed: "已完成",
};
const JP_STATUS_ORDER = ["purchased", "at_jp_warehouse", "shipping_intl", "delivered", "completed"];

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export const getPurchaseStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PurchaseStats> => {
    const { supabase } = context;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const trendStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const [jpRes, dmRes, dbRes, dbCountRes, jpStatusRes, jpRecentRes, dmRecentRes, dbRecentRes] =
      await Promise.all([
        supabase
          .from("japan_parcels")
          .select("id,intl_pay_at,purchased_at,grand_total_cny,total_cny")
          .is("deleted_at", null),
        supabase
          .from("domestic_orders")
          .select("id,item_title,platform,total_cny,purchased_at,status")
          .is("deleted_at", null),
        supabase
          .from("domestic_bulk_orders")
          .select("id,supplier_name,total_cny,purchased_at,status")
          .is("deleted_at", null),
        supabase
          .from("domestic_bulk_orders")
          .select("id", { count: "exact", head: true })
          .is("deleted_at", null),
        supabase.from("japan_parcels").select("status").is("deleted_at", null),
        supabase
          .from("japan_parcels")
          .select("id,item_title,item_title_cn,grand_total_cny,total_cny,purchased_at,status,updated_at")
          .is("deleted_at", null)
          .order("updated_at", { ascending: false })
          .limit(8),
        supabase
          .from("domestic_orders")
          .select("id,item_title,total_cny,purchased_at,status,updated_at")
          .is("deleted_at", null)
          .order("updated_at", { ascending: false })
          .limit(8),
        supabase
          .from("domestic_bulk_orders")
          .select("id,supplier_name,total_cny,purchased_at,status,updated_at")
          .is("deleted_at", null)
          .order("updated_at", { ascending: false })
          .limit(8),
      ]);

    for (const r of [jpRes, dmRes, dbRes, jpStatusRes, jpRecentRes, dmRecentRes, dbRecentRes]) {
      if (r.error) throw new Error(r.error.message);
    }

    // 趋势桶
    const trendMap = new Map<
      string,
      { japan_parcel: number; japan_bulk: number; domestic: number; domestic_bulk: number }
    >();
    for (let i = 0; i < 12; i++) {
      const d = new Date(trendStart.getFullYear(), trendStart.getMonth() + i, 1);
      trendMap.set(monthKey(d), { japan_parcel: 0, japan_bulk: 0, domestic: 0, domestic_bulk: 0 });
    }

    function bucket(ts: string, amt: number, ch: "japan_parcel" | "domestic" | "domestic_bulk") {
      const d = new Date(ts);
      const k = monthKey(d);
      if (trendMap.has(k)) trendMap.get(k)![ch] += amt;
      return {
        all: amt,
        ytd: d >= yearStart ? amt : 0,
        month: d >= monthStart ? amt : 0,
      };
    }

    // 日本小包：按包裹聚合，金额取 grand_total_cny（含商品 + 国际运费 + 关税）
    const jpStat = { month: 0, ytd: 0, all: 0, count: 0 };
    let jpMonthCount = 0;
    for (const r of jpRes.data ?? []) {
      const amt = Number(r.grand_total_cny ?? r.total_cny ?? 0);
      jpStat.all += amt;
      jpStat.count += 1;
      const ts = (r.intl_pay_at as string) || (r.purchased_at as string);
      if (!ts) continue;
      const b = bucket(ts, amt, "japan_parcel");
      jpStat.ytd += b.ytd;
      jpStat.month += b.month;
      if (new Date(ts) >= monthStart) jpMonthCount += 1;
    }

    // 国内小包
    const dmStat = { month: 0, ytd: 0, all: 0, count: dmRes.data?.length ?? 0 };
    let dmMonthCount = 0;
    for (const r of dmRes.data ?? []) {
      if (!r.purchased_at) continue;
      const amt = Number(r.total_cny ?? 0);
      const b = bucket(r.purchased_at as string, amt, "domestic");
      dmStat.all += b.all;
      dmStat.ytd += b.ytd;
      dmStat.month += b.month;
      if (new Date(r.purchased_at as string) >= monthStart) dmMonthCount += 1;
    }

    // 国内大宗
    const dbStat = { month: 0, ytd: 0, all: 0, count: dbCountRes.count ?? dbRes.data?.length ?? 0 };
    let dbMonthCount = 0;
    for (const r of dbRes.data ?? []) {
      if (!r.purchased_at) continue;
      const amt = Number(r.total_cny ?? 0);
      const b = bucket(r.purchased_at as string, amt, "domestic_bulk");
      dbStat.all += b.all;
      dbStat.ytd += b.ytd;
      dbStat.month += b.month;
      if (new Date(r.purchased_at as string) >= monthStart) dbMonthCount += 1;
    }

    const bulkStat = { month: 0, ytd: 0, all: 0, count: 0 };

    const byChannel: ChannelStat[] = [
      { key: "japan_parcel", label: CHANNEL_LABEL.japan_parcel, ...jpStat },
      { key: "domestic", label: CHANNEL_LABEL.domestic, ...dmStat },
      { key: "domestic_bulk", label: CHANNEL_LABEL.domestic_bulk, ...dbStat },
      { key: "japan_bulk", label: CHANNEL_LABEL.japan_bulk, ...bulkStat, placeholder: true },
    ];

    // 日本小包状态分布
    const statusCount = new Map<string, number>();
    for (const r of jpStatusRes.data ?? []) {
      const k = (r.status as string) || "purchased";
      statusCount.set(k, (statusCount.get(k) ?? 0) + 1);
    }
    const byStatus: StatusBucket[] = JP_STATUS_ORDER.map((k) => ({
      key: k,
      label: JP_STATUS_LABEL[k],
      count: statusCount.get(k) ?? 0,
    }));

    // 最近动态合并
    const recent: RecentItem[] = [];
    for (const r of jpRecentRes.data ?? []) {
      recent.push({
        id: String(r.id),
        channel: "japan_parcel",
        title: (r.item_title_cn as string) || (r.item_title as string) || "（未命名包裹）",
        amount: Number(r.grand_total_cny ?? r.total_cny ?? 0),
        ts: (r.updated_at as string) || (r.purchased_at as string) || new Date().toISOString(),
        status: (r.status as string) ?? null,
      });
    }
    for (const r of dmRecentRes.data ?? []) {
      recent.push({
        id: String(r.id),
        channel: "domestic",
        title: (r.item_title as string) || "（国内小包）",
        amount: Number(r.total_cny ?? 0),
        ts: (r.updated_at as string) || (r.purchased_at as string) || new Date().toISOString(),
        status: (r.status as string) ?? null,
      });
    }
    for (const r of dbRecentRes.data ?? []) {
      recent.push({
        id: String(r.id),
        channel: "domestic_bulk",
        title: (r.supplier_name as string) || "（大宗采购）",
        amount: Number(r.total_cny ?? 0),
        ts: (r.updated_at as string) || (r.purchased_at as string) || new Date().toISOString(),
        status: (r.status as string) ?? null,
      });
    }
    recent.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    const monthlyTrend = Array.from(trendMap.entries()).map(([month, v]) => ({ month, ...v }));

    return {
      totals: {
        month: jpStat.month + dmStat.month + dbStat.month,
        ytd: jpStat.ytd + dmStat.ytd + dbStat.ytd,
        all: jpStat.all + dmStat.all + dbStat.all,
        count: jpStat.count + dmStat.count + dbStat.count,
        monthCount: jpMonthCount + dmMonthCount + dbMonthCount,
      },
      byChannel,
      monthlyTrend,
      byStatus,
      recent: recent.slice(0, 10),
    };
  });
