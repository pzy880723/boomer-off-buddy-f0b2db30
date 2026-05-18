import { createFileRoute } from "@tanstack/react-router";

// TEMPORARY: one-time key dump for CVM redeployment after rotation.
// DELETE this file immediately after use.
export const Route = createFileRoute("/api/public/_keydump")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("t");
        if (token !== "rot-2026-05-18") {
          return new Response("nope", { status: 404 });
        }
        return new Response(
          JSON.stringify({
            SUPABASE_URL: process.env.SUPABASE_URL ?? null,
            SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY ?? null,
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
