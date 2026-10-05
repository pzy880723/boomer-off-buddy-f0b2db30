// 有赞「消息订阅」推送状态查询
// 交易日志和会员资产收件箱均使用当前用户的 RLS 权限。
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getMessagePushStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("youzan_sync_logs")
      .select("id, kdt_id, status, message, error, started_at")
      .eq("action", "message_push")
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    const tradeLogs = (data ?? []) as Array<{
      id: string;
      kdt_id: number | null;
      status: string;
      message: string | null;
      error: string | null;
      started_at: string;
    }>;
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const [assets, tradeCount, assetCount] = await Promise.all([
      supabase.from("youzan_member_asset_inbox")
        .select("id,kdt_id,msg_type,status,reason,received_at")
        .order("received_at", { ascending: false }).limit(20),
      supabase.from("youzan_sync_logs").select("id", { count: "exact", head: true })
        .eq("action", "message_push").gte("started_at", since),
      supabase.from("youzan_member_asset_inbox").select("id", { count: "exact", head: true })
        .gte("received_at", since),
    ]);
    if (assets.error || tradeCount.error || assetCount.error) throw new Error("推送状态暂不可读");
    const assetLogs = (assets.data ?? []).map(row => ({
      id: `asset:${row.id}`, kdt_id: row.kdt_id, status: row.status,
      message: `${row.msg_type} · ${row.reason ?? row.status}`,
      error: null, started_at: row.received_at,
    }));
    const logs = [...tradeLogs, ...assetLogs]
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, 20);
    const last = logs[0]?.started_at ?? null;
    const total24h = (tradeCount.count ?? 0) + (assetCount.count ?? 0);
    return { lastReceivedAt: last, total24h, logs };
  });
