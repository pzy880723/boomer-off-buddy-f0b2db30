import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { AiRecognizeReq } from "@/lib/handheld/schemas";
import { aiRecognizeItem } from "@/server/handheld-ai.server";

export const Route = createFileRoute("/api/public/handheld/ai/recognize-item")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        let body: { image_url?: string; image_base64?: string; hint?: string };
        try {
          body = AiRecognizeReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        try {
          const out = await aiRecognizeItem(body);
          return ok(out);
        } catch (e) {
          return err(`AI recognition failed: ${(e as Error).message}`, 502);
        }
      },
    },
  },
});
