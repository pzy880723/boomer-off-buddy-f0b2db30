// GET /api/public/go/leaderboard?period=today|month[&location_id=<uuid>]
// 员工龙虎榜（只读、不参与考核）。复用 GO 身份核验与排班门店授权；参数不能扩大门店范围。
// 当前无可信销售归属 → 200 + complete=false + reason=employee_attribution_unavailable，rows 为空。
import { createFileRoute } from "@tanstack/react-router";
import { GO_CORS, authenticateGoActor, goJson, goTraced } from "@/server/go-bridge.server";
import { buildGoLeaderboard, parseLeaderboardPeriod } from "@/lib/go-bridge/leaderboard";

function privateNoStore(res: Response) {
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("Vary", "Authorization");
  return res;
}

export const Route = createFileRoute("/api/public/go/leaderboard")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: GO_CORS }),
      GET: async ({ request }) =>
        privateNoStore(
          await goTraced("leaderboard", async (timing) => {
            const url = new URL(request.url);
            const period = parseLeaderboardPeriod(url.searchParams.get("period"));
            if (!period) {
              return goJson({ ok: false, code: "invalid_period", error: "period 只能是 today 或 month" }, 400);
            }
            const actor = await authenticateGoActor(request, new Date(), timing);
            const data = buildGoLeaderboard({ actor, period, requestedLocationId: url.searchParams.get("location_id") });
            timing.mark("leaderboard");
            return goJson({ ok: true, data });
          }),
        ),
    },
  },
});
