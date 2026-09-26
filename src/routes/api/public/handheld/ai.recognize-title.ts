import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { AiTitleReq } from "@/lib/handheld/schemas";
import { recognizeProductTitle } from "@/server/product-title.server";

export const Route = createFileRoute("/api/public/handheld/ai/recognize-title")({
  server: { handlers: {
    OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
    POST: async ({ request }) => {
      const auth = await authenticateDevice(request);
      if (!auth.ok) return auth.response;
      const body = AiTitleReq.safeParse(await request.json().catch(() => null));
      if (!body.success) return err("Invalid image", 400, { code: "validation_error" });
      try { return ok({ name: await recognizeProductTitle(body.data.image_base64) }); }
      catch { return err("快速标题暂不可用，完整识别继续进行", 503); }
    },
  } },
});
