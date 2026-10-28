// POST /api/public/handheld/sales-channels/batch-apply
// 只执行快照里的 SKU/版本/变更；同 op_id 重试返回原结果；逐件可失败，未选商品不受影响。
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HANDHELD_CORS, ok, err } from "@/server/handheld-auth.server";
import {
  SalesChannelError,
  authorizeSalesChannelStaff,
  callApplyRpc,
} from "@/server/sales-channels.server";
import { aggregateBySku } from "@/lib/sales-channels/model";

const Body = z.object({
  location_id: z.string().uuid(),
  op_id: z.string().uuid(),
  preview_token: z.string().uuid(),
});

export const Route = createFileRoute("/api/public/handheld/sales-channels/batch-apply")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        try {
          let body: z.infer<typeof Body>;
          try { body = Body.parse(await request.json()); }
          catch { return err("请求参数不正确", 400, { code: "invalid_body" }); }
          const ctx = await authorizeSalesChannelStaff(request, body.location_id);
          if (!ctx.canManage) return err("当前角色不能修改销售渠道", 403, { code: "role_forbidden" });
          const data = await callApplyRpc("sales_channel_apply_preview", {
            p_actor: ctx.userId, p_location: ctx.locationId, p_op_id: body.op_id, p_token: body.preview_token,
          });
          // 返回全部最初选择的 SKU（含预览跳过）；重放来自同一份持久结果。
          const skuIds = data.sku_ids ?? [...new Set(data.results.map((r) => r.sku_id))];
          const results = aggregateBySku(skuIds, data.results, data.skipped ?? []);
          const succeeded = results.filter((r) => r.success).length;
          return ok({ total: results.length, succeeded, failed: results.length - succeeded, replayed: !!data.replayed, results });
        } catch (e) {
          if (e instanceof SalesChannelError) return err(e.message, e.status, { code: e.code });
          return err("批量执行失败", 500, { code: "batch_failed" });
        }
      },
    },
  },
});
