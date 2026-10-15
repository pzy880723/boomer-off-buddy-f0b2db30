import { createFileRoute } from "@tanstack/react-router";

// 有赞积分投影补偿刷新：只读有赞，只刷新已映射且最久未同步的顾客。
// 仅接受本项目 service-role Bearer（腾讯定时器调用）；无 CORS；不接收任何顾客/手机号参数。
const BATCH = 20;

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
function authorized(request: Request): boolean {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const header = request.headers.get("authorization") ?? "";
  return key.length >= 20 && header.startsWith("Bearer ") && safeEqual(header.slice(7), key);
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const Route = createFileRoute("/api/public/hooks/youzan-points-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { productionPointsProjection } = await import("@/server/youzan-points-projection-production.server");
        const { data, error } = await supabaseAdmin.from("youzan_points_projection")
          .select("customer_id").not("yz_open_id", "is", null)
          .order("balance_synced_at", { ascending: true, nullsFirst: true }).limit(BATCH);
        if (error) return json({ ok: false, error: "projection_read_failed" }, 500);
        const projection = await productionPointsProjection();
        const counts: Record<string, number> = {};
        for (const row of data ?? []) {
          let r: string;
          try { r = await projection.refresh(row.customer_id); } catch { r = "error"; }
          counts[r] = (counts[r] ?? 0) + 1;
        }
        return json({ ok: true, scanned: (data ?? []).length, results: counts });
      },
    },
  },
});
