import { createFileRoute } from "@tanstack/react-router";

// 新人券包发放作业：只接受本项目 service-role Bearer（腾讯定时器调用）；无 CORS；不接收顾客参数。
// 开关默认关闭（NEWCOMER_BENEFIT_WORKER_ENABLED），关闭时不领取任何槽位。
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

export const Route = createFileRoute("/api/public/hooks/newcomer-benefit-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) return json({ ok: false, error: "unauthorized" }, 401);
        const { runNewcomerWorker, syncYouzanCouponMirrors } = await import("@/server/newcomer-benefit.server");
        const prod = await import("@/server/newcomer-benefit-production.server");
        try {
          const backfill = await prod.backfillNewcomerIfEnabled();
          const worker = await runNewcomerWorker(prod.productionNewcomerDeps(), 10);
          const mirror = await syncYouzanCouponMirrors(prod.productionMirrorSyncDeps(), 50);
          return json({ ok: true, backfill, ...worker, mirror });
        } catch {
          return json({ ok: false, error: "newcomer_worker_failed" }, 500);
        }
      },
    },
  },
});
