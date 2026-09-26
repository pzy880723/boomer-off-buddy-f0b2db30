import { createFileRoute } from "@tanstack/react-router";
import {
  HANDHELD_CORS,
  authenticateDevice,
  resolveSessionUser,
  ok,
  err,
} from "@/server/handheld-auth.server";
import { CustomTransferRequest } from "@/lib/custom-transfer-contract";
import { CustomTransferError, executeCustomTransfer } from "@/server/custom-transfers.server";

export const Route = createFileRoute("/api/public/handheld/custom-transfers")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const device = await authenticateDevice(request);
        if (!device.ok) return device.response;
        const user = await resolveSessionUser(request);
        if (!user) return err("请重新登录", 401, { code: "session_required" });
        let data;
        try {
          data = CustomTransferRequest.parse(await request.json());
        } catch {
          return err("调拨参数无效", 400, { code: "validation_error" });
        }
        try {
          return ok(await executeCustomTransfer(user.user_id, data));
        } catch (e) {
          if (e instanceof CustomTransferError) return err(e.message, e.status, { code: e.code });
          console.error("[custom-transfer-route]", e);
          return err("调拨暂未完成，请重试", 503);
        }
      },
    },
  },
});
