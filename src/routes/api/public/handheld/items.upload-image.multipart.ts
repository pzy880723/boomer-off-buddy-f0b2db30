import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/items/upload-image/multipart")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const path = url.searchParams.get("path");
        const bucket = (url.searchParams.get("bucket") || "sku-raw") as "sku-raw" | "sku-listing";
        if (!path) return err("Missing path", 400);
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof Blob)) return err("Missing 'file' field", 400);
        const up = await supabaseAdmin.storage
          .from(bucket)
          .upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
        if (up.error) return err(up.error.message, 500);
        return ok({ storage_path: path, bucket });
      },
    },
  },
});
