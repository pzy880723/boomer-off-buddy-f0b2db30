// GET /api/public/go/store/daily-sales?date=yyyy-mm-dd[&location_id=<uuid>]
// 与 /api/public/go/daily-summary 完全同一套鉴权与口径的原生别名路由：
//  - 只接受固定 GO issuer 的用户 Bearer JWT，由 GO auth.getUser 实际核验（不本地 decode）；
//  - 门店由 GO 可信排班 + ERP 显式 go_shop_location_links 映射决定，不信任客户端字段；
//  - 未配置映射/身份集成 → 503 go_bridge_not_configured / 403，不返回任何跨店数据；
//  - 金额整数分；缺退款源时 completeness.kind="paid_gross" 且 complete=false。
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

export const Route = createFileRoute("/api/public/go/store/daily-sales")({
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
