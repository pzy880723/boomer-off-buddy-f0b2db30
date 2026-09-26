import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, err } from "@/server/handheld-auth.server";
import { handleProductContent } from "@/server/product-content.server";

export const Route = createFileRoute("/api/public/handheld/items/$id/content")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      POST: async ({ request, params }) => {
        try {
          const auth = await authenticateDevice(request);
          if (!auth.ok) return auth.response;
          return await handleProductContent(request, auth.device, params.id);
        } catch {
          return err("Product content unavailable", 500, { code: "internal_error" });
        }
      },
    },
  },
});
