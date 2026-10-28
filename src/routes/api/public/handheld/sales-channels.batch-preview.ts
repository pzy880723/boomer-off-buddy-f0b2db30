// POST /api/public/handheld/sales-channels/batch-preview
// 只读计算 + 保存快照（actor+门店+SKU+版本+变更+10分钟有效期）；不改任何渠道。
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HANDHELD_CORS, ok, err } from "@/server/handheld-auth.server";
import {
  SalesChannelError,
  authorizeSalesChannelStaff,
  createPreview,
  loadChannelFacts,
} from "@/server/sales-channels.server";
import { planSkuChanges, reasonLabel } from "@/lib/sales-channels/model";

const Channel = z.enum(["miniapp", "app", "youzan"]);
const Body = z.object({
  location_id: z.string().uuid(),
  sku_ids: z.array(z.string().uuid()).min(1).max(100),
  add: z.array(Channel).max(3).default([]),
  remove: z.array(Channel).max(3).default([]),
}).refine((b) => b.add.length + b.remove.length > 0, "empty change")
  .refine((b) => !b.add.some((c) => b.remove.includes(c)), "add/remove overlap")
  .refine((b) => new Set(b.sku_ids).size === b.sku_ids.length, "duplicate sku");

export const Route = createFileRoute("/api/public/handheld/sales-channels/batch-preview")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        try {
          let body: z.infer<typeof Body>;
          try { body = Body.parse(await request.json()); }
          catch (e) {
            const empty = e instanceof z.ZodError && e.issues.some((i) => i.message === "empty change");
            return err(empty ? "请至少选择一个要追加或移除的渠道" : "请求参数不正确", 400, { code: empty ? "no_changes" : "invalid_body" });
          }
          const ctx = await authorizeSalesChannelStaff(request, body.location_id);
          if (!ctx.canManage) return err("当前角色不能修改销售渠道", 403, { code: "role_forbidden" });
          const add = [...new Set(body.add)], remove = [...new Set(body.remove)];
          const facts = await loadChannelFacts(ctx, body.sku_ids);
          const items: Array<{ sku_id: string; changes: Record<string, unknown> }> = [];
          const skipped: Array<{ sku_id: string; reason: string }> = [];
          for (const id of body.sku_ids) {
            const plan = planSkuChanges(facts.get(id)!, add, remove);
            if (plan.skipReason) skipped.push({ sku_id: id, reason: reasonLabel(plan.skipReason)! });
            else items.push({ sku_id: id, changes: plan.changes });
          }
          if (!items.length) {
            return err("所选商品都不能执行该变更", 422, { code: "no_eligible_items", total: body.sku_ids.length, eligible: 0, skipped });
          }
          const preview = await createPreview(ctx, add, remove, items);
          return ok({
            preview_token: preview.token,
            total: body.sku_ids.length,
            eligible: items.length,
            skipped,
            expires_at: preview.expires_at,
          });
        } catch (e) {
          if (e instanceof SalesChannelError) return err(e.message, e.status, { code: e.code });
          return err("预览失败", 500, { code: "preview_failed" });
        }
      },
    },
  },
});
