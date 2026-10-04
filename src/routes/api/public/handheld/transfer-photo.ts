import { createFileRoute } from "@tanstack/react-router";
import { readERPImage, verifyReceiptPhotoURL } from "@/server/erp-image-delivery.server";

export const Route = createFileRoute("/api/public/handheld/transfer-photo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const grant = verifyReceiptPhotoURL(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
        if (!grant)
          return new Response("Receipt link expired", {
            status: 403,
            headers: { "Cache-Control": "no-store" },
          });
        try {
          const bytes = await readERPImage("transfer-receipts", grant.path, grant.width);
          const remaining = Math.max(
            0,
            Number(url.searchParams.get("expires")) - Math.ceil(Date.now() / 1000),
          );
          return new Response(new Uint8Array(bytes), {
            headers: {
              "Content-Type": "image/jpeg",
              "Cache-Control": `private, max-age=${remaining}`,
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("Image temporarily unavailable", {
            status: 502,
            headers: { "Cache-Control": "no-store" },
          });
        }
      },
    },
  },
});
