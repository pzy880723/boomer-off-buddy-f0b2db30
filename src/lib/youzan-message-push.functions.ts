// 有赞「消息订阅」推送状态查询
// 读 youzan_sync_logs 里 action='message_push' 的记录，
// 面板据此判断"有赞推送是否已联通"
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getMessagePushStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("youzan_sync_logs")
      .select("id, kdt_id, status, message, raw, started_at")
      .eq("action", "message_push")
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    const logs = (data ?? []) as Array<{
      id: string;
      kdt_id: number | null;
      status: string;
      message: string | null;
      raw: unknown;
      started_at: string;
    }>;
    const last = logs[0]?.started_at ?? null;
    return {
      lastReceivedAt: last,
      total24h: logs.filter(
        (l) => Date.now() - new Date(l.started_at).getTime() < 86_400_000,
      ).length,
      logs,
    };
  });
