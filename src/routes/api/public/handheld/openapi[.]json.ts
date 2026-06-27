import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS } from "@/server/handheld-auth.server";
import { buildHandheldOpenApi } from "@/lib/handheld/openapi";

export const Route = createFileRoute("/api/public/handheld/openapi.json")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async () => {
        const doc = buildHandheldOpenApi();
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=60",
            ...HANDHELD_CORS,
          },
        });
      },
    },
  },
});
