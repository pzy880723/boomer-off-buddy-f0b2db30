import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { SignReadUrlReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/items/sign-read-url")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        let body: { bucket: "sku-raw" | "sku-listing"; storage_path: string; expires_in: number };
        try {
          body = SignReadUrlReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        const signed = await supabaseAdmin.storage
          .from(body.bucket)
          .createSignedUrl(body.storage_path, body.expires_in);
        if (signed.error)
          return err(signed.error.message, signed.error.message.includes("not found") ? 404 : 500);
        return ok({
          storage_path: body.storage_path,
          read_url: signed.data.signedUrl,
          expires_in: body.expires_in,
        });
      },
    },
  },
});
