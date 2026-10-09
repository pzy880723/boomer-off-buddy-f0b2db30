import { createFileRoute } from "@tanstack/react-router";
import { aiConsentErrorResponse, requireAiActor } from "@/server/ai-consent.server";
import { HANDHELD_CORS, ok, err } from "@/server/handheld-auth.server";
import { AiTitleReq } from "@/lib/handheld/schemas";
import { recognizeProductTitle } from "@/server/product-title.server";

export const Route = createFileRoute("/api/public/handheld/ai/recognize-title")({
  server: { handlers: {
    OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
    POST: async ({ request }) => {
      const auth = await requireAiActor(request);
      if (!auth.ok) return auth.response;
      const body = AiTitleReq.safeParse(await request.json().catch(() => null));
      if (!body.success) return err("Invalid image", 400, { code: "validation_error" });
      try { return ok({ name: await recognizeProductTitle(body.data.image_base64, auth.guard) }); }
      catch (e) { return aiConsentErrorResponse(e) ?? err("快速标题暂不可用，完整识别继续进行", 503); }
    },
  } },
});
