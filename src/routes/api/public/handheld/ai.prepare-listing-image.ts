import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { AiListingImageReq } from "@/lib/handheld/schemas";
import { aiPrepareListingImage } from "@/server/handheld-ai.server";

export const Route = createFileRoute("/api/public/handheld/ai/prepare-listing-image")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        let body: { image_url?: string; image_base64?: string; instruction?: string };
        try {
          body = AiListingImageReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }

        try {
          const { b64, mime } = await aiPrepareListingImage(body);
          const buf = Buffer.from(b64, "base64");
          const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
          const path = `${new Date().toISOString().slice(0, 10)}/${auth.device.id}/${crypto.randomUUID()}.${ext}`;
          const up = await supabaseAdmin.storage.from("sku-listing").upload(path, buf, {
            contentType: mime,
            cacheControl: "31536000",
            upsert: false,
          });
          if (up.error) return err(`Storage upload failed: ${up.error.message}`, 500);
          const signed = await supabaseAdmin.storage
            .from("sku-listing")
            .createSignedUrl(path, 60 * 60 * 24 * 7);
          if (signed.error) return err(`Sign URL failed: ${signed.error.message}`, 500);
          return ok({ storage_path: path, signed_url: signed.data.signedUrl, mime_type: mime });
        } catch (e) {
          return err(`AI image edit failed: ${(e as Error).message}`, 502);
        }
      },
    },
  },
});
