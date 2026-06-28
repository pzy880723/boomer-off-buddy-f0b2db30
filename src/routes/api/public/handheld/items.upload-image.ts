import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { UploadImageReq } from "@/lib/handheld/schemas";

export const Route = createFileRoute("/api/public/handheld/items/upload-image")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        let body: {
          bucket: "sku-raw" | "sku-listing";
          filename: string;
          content_type: string;
          mode: "signed" | "multipart";
        };
        try {
          body = UploadImageReq.parse(await request.json());
        } catch (e) {
          return err("Invalid body", 400, { detail: String(e) });
        }
        const extMatch = body.filename.match(/\.([a-zA-Z0-9]{1,6})$/);
        const ext = (extMatch?.[1] || "jpg").toLowerCase();
        const path = `${new Date().toISOString().slice(0, 10)}/${auth.device.id}/${crypto.randomUUID()}.${ext}`;
        const signedRead = await supabaseAdmin.storage
          .from(body.bucket)
          .createSignedUrl(path, 60 * 60 * 24 * 7);
        if (signedRead.error) return err(signedRead.error.message, 500);

        if (body.mode === "multipart") {
          const origin = new URL(request.url).origin;
          const upload_url = `${origin}/api/public/handheld/items/upload-image/multipart?path=${encodeURIComponent(path)}&bucket=${encodeURIComponent(body.bucket)}`;
          return ok({
            storage_path: path,
            upload_url,
            read_url: signedRead.data.signedUrl,
            method: "POST" as const,
            mode: "multipart" as const,
            headers: {
              "X-Device-Token": "<echo your X-Device-Token>",
              // Multipart form-data; field name 'file'
            },
          });
        }

        const signedUpload = await supabaseAdmin.storage
          .from(body.bucket)
          .createSignedUploadUrl(path);
        if (signedUpload.error) return err(signedUpload.error.message, 500);
        return ok({
          storage_path: path,
          upload_url: signedUpload.data.signedUrl,
          read_url: signedRead.data.signedUrl,
          method: "PUT" as const,
          mode: "signed" as const,
          headers: { "Content-Type": body.content_type, "x-upsert": "false" },
        });
      },
    },
  },
});
