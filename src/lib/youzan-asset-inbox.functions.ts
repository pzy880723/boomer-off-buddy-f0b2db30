// 管理员查看有赞积分/券消息收件箱处理状态。
// 走用户自己的会话 + RLS（仅 super_admin / hq_operator 可读）；不返回消息原文 payload。
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getYouzanAssetInboxStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("youzan_member_asset_inbox")
      .select(
        "id, kdt_id, event_id, msg_type, biz_id, msg_version, redelivery_count, status, reason, attempts, next_attempt_at, conflict_count, last_conflict_at, received_at, updated_at",
      )
      .order("received_at", { ascending: false })
      .limit(100);
    if (error) throw new Error("收件箱状态暂不可读");
    const rows = data ?? [];
    // 仅最近 100 条的分布，不是全局统计。
    const recentCounts: Record<string, number> = {};
    for (const r of rows) recentCounts[r.status] = (recentCounts[r.status] ?? 0) + 1;
    return { recentLimit: 100, recentCounts, rows };
  });
