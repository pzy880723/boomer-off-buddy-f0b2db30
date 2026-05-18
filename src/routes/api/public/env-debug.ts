import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/env-debug")({
  server: {
    handlers: {
      GET: async () => {
        const names = Object.keys(process.env).filter((k) => k.includes("SUPABASE"));
        const out: Record<string, string> = {};
        for (const n of names) {
          const v = process.env[n] ?? "";
          out[n] = v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-4)} (len=${v.length})` : `len=${v.length}`;
        }
        return Response.json({ names, out });
      },
    },
  },
});
