import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok, err } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { UploadImageReq } from "@/lib/handheld/schemas";
import { createUploadRelayGrant, relayImageUpload } from "@/server/handheld-upload-relay.server";

const UPLOAD_CORS = {
  ...HANDHELD_CORS,
  "Access-Control-Allow-Headers": `${HANDHELD_CORS["Access-Control-Allow-Headers"]}, X-Upload-Token, x-upsert`,
};

export const Route = createFileRoute("/api/public/handheld/items/upload-image")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: UPLOAD_CORS }),
      PUT: ({ request }) => relayImageUpload(request, {
        secret: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        storageOrigin: process.env.SUPABASE_URL || "",
        headers: UPLOAD_CORS,
      }),
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

        // NOTE: Supabase Storage 的 createSignedUrl 要求对象已存在。上传前没法签 read URL，
        // 否则会返回 500 {"error":"Object not found"}。APP 上传完成后调
        // POST /items/sign-read-url 拿 read URL。
        if (body.mode === "multipart") {
          const origin = new URL(request.url).origin;
          const upload_url = `${origin}/api/public/handheld/items/upload-image/multipart?path=${encodeURIComponent(path)}&bucket=${encodeURIComponent(body.bucket)}`;
          return ok({
            storage_path: path,
            upload_url,
            read_url: null,
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
        const uploadToken = createUploadRelayGrant(
          signedUpload.data.signedUrl, body.content_type,
          process.env.SUPABASE_SERVICE_ROLE_KEY || "", process.env.SUPABASE_URL || "",
        );
        return ok({
          storage_path: path,
          upload_url: new URL("/api/public/handheld/items/upload-image", request.url).toString(),
          read_url: null,
          method: "PUT" as const,
          mode: "signed" as const,
          headers: { "Content-Type": body.content_type, "x-upsert": "false", "X-Upload-Token": uploadToken },
        });
      },
    },
  },
});
