// POST /api/public/handheld/ai/generate-summary
// 拍照上架确认页「刷新简介」：只依据当前确认资料重新生成简介。
// 不接收图片、不重跑识别、不写 SKU/库存/发布状态。
import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  err,
  ok,
  resolveSessionUser,
} from "@/server/handheld-auth.server";
import { SummaryInput, generateListingSummary } from "@/server/listing-summary.server";

export const Route = createFileRoute("/api/public/handheld/ai/generate-summary")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const session = await resolveSessionUser(request);
        if (!session) return err("Employee session required", 401, { code: "session_required" });
        const body = SummaryInput.safeParse(await request.json().catch(() => null));
        if (!body.success) return err("Invalid request", 422, { code: "validation_error" });
        try {
          const description = await generateListingSummary(body.data);
          return ok({ description });
        } catch {
          return err("简介生成失败，请稍后重试", 503);
        }
      },
    },
  },
});
