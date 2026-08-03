import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { ContentGenerateReq } from "@/lib/handheld/schemas";
import { replayIfPresent, recordOp, jsonReplay } from "@/server/handheld-idempotency.server";
import { generateEditorialForSku } from "@/server/handheld-editorial.server";

export const Route = createFileRoute("/api/public/handheld/content/generate-from-sku")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;

        let body: ReturnType<typeof ContentGenerateReq.parse>;
        try {
          body = ContentGenerateReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { code: "validation_error", detail: String(e) });
        }

        const replay = await replayIfPresent({
          deviceId: auth.device.id,
          clientOpId: body.client_op_id,
          opType: "content.generate-from-sku",
        });
        if (replay) return jsonReplay(replay);

        try {
          const data = await generateEditorialForSku({
            skuId: body.sku_id,
            publish: body.publish,
          });
          await recordOp({
            deviceId: auth.device.id,
            clientOpId: body.client_op_id,
            opType: "content.generate-from-sku",
            status: 200,
            body: { ok: true, data },
          });
          return ok(data);
        } catch (e) {
          return err(`生成达人文案失败：${(e as Error).message}`, 502);
        }
      },
    },
  },
});
