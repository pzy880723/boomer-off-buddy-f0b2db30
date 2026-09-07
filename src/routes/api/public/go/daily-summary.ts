// GET /api/public/go/daily-summary?date=yyyy-mm-dd&location_id=<uuid>
// 总部不传 location_id → 所有真实门店（不含仓库）；员工只能拿到当天排班门店，越权 403。
// 金额均为整数分；缺退款数据源时明示 paid_gross + incomplete，任一门店缺数据不按 0 合计。
import { createFileRoute } from "@tanstack/react-router";
import {
  GO_CORS,
  authenticateGoActor,
  goError,
  goJson,
  loadGoDailySummary,
  scopeForActor,
} from "@/server/go-bridge.server";
import { shanghaiToday } from "@/lib/store-targets/sales-window";

export const Route = createFileRoute("/api/public/go/daily-summary")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: GO_CORS }),
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const date = url.searchParams.get("date") ?? shanghaiToday();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return goJson(
              { ok: false, code: "invalid_date", error: "date 必须是 yyyy-mm-dd" },
              400,
            );
          }
          const actor = await authenticateGoActor(request);
          const scope = scopeForActor(actor, url.searchParams.get("location_id"));
          const data = await loadGoDailySummary({ actor, scope, date });
          return goJson({ ok: true, data });
        } catch (e) {
          return goError(e);
        }
      },
    },
  },
});
