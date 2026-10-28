// GET/POST /api/public/handheld/items/{id}/sales-channels?location_id=
// 渠道选择（意图）与平台实际状态分开返回；写入只经 0117 sales_channel_apply（service_role）。
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { HANDHELD_CORS, ok, err } from "@/server/handheld-auth.server";
import {
  SalesChannelError,
  authorizeSalesChannelStaff,
  callApplyRpc,
  channelStateResponse,
} from "@/server/sales-channels.server";
import { reasonLabel, sha256Hex, singleRequestFingerprint } from "@/lib/sales-channels/model";

const Uuid = z.string().uuid();
const Body = z.object({
  location_id: Uuid,
  op_id: Uuid,
  changes: z.array(z.object({
    channel: z.enum(["miniapp", "app", "youzan"]),
    enabled: z.boolean(),
    expected_version: z.number().int().min(0),
  })).min(1).max(3).refine((c) => new Set(c.map((x) => x.channel)).size === c.length, "duplicate channel"),
});

function fail(e: unknown) {
  if (e instanceof SalesChannelError) return err(e.message, e.status, { code: e.code, ...(e.extra ?? {}) });
  return err("渠道操作失败", 500, { code: "channel_failed" });
}

export const Route = createFileRoute("/api/public/handheld/items/$id/sales-channels")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request, params }) => {
        try {
          if (!Uuid.safeParse(params.id).success) return err("Invalid id", 400, { code: "invalid_id" });
          const ctx = await authorizeSalesChannelStaff(request, new URL(request.url).searchParams.get("location_id"));
          return ok(await channelStateResponse(ctx, params.id));
        } catch (e) { return fail(e); }
      },
      POST: async ({ request, params }) => {
        try {
          if (!Uuid.safeParse(params.id).success) return err("Invalid id", 400, { code: "invalid_id" });
          let body: z.infer<typeof Body>;
          try { body = Body.parse(await request.json()); }
          catch { return err("请求参数不正确", 400, { code: "invalid_body" }); }
          const ctx = await authorizeSalesChannelStaff(request, body.location_id);
          if (!ctx.canManage) return err("当前角色不能修改销售渠道", 403, { code: "role_forbidden" });
          const hash = await sha256Hex(singleRequestFingerprint(params.id, body.changes));
          const data = await callApplyRpc("sales_channel_apply", {
            p_actor: ctx.userId, p_location: ctx.locationId, p_op_id: body.op_id, p_kind: "single",
            p_request_hash: hash,
            p_changes: body.changes.map((c) => ({ ...c, sku_id: params.id })),
          });
          const state = await channelStateResponse(ctx, params.id);
          return ok({
            ...state,
            replayed: !!data.replayed,
            results: data.results.map((r) => ({
              sku_id: r.sku_id, channel: r.channel, success: r.success,
              ...(r.reason ? { reason: reasonLabel(r.reason), reason_code: r.reason } : {}),
              ...(r.status ? { status: r.status } : {}),
            })),
          });
        } catch (e) { return fail(e); }
      },
    },
  },
});
