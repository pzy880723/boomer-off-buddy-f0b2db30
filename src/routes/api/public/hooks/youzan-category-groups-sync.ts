import { createFileRoute } from "@tanstack/react-router";
import {
  assertCategoryGroupSyncHost,
  parseCategoryGroupSyncRequest,
} from "@/lib/youzan-category-groups";

function unauthorized() {
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export const Route = createFileRoute("/api/public/hooks/youzan-category-groups-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
        const authorization = request.headers.get("authorization") ?? "";
        if (!serviceRoleKey || authorization !== `Bearer ${serviceRoleKey}`) return unauthorized();

        let body: Record<string, unknown> = {};
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          // Empty request means a full dry run.
        }

        try {
          const options = parseCategoryGroupSyncRequest(body);
          assertCategoryGroupSyncHost(new URL(request.url).hostname, options.dryRun);
          const { syncErpCategoriesToYouzanGroups } = await import(
            "@/lib/youzan-category-groups.server"
          );
          const result = await syncErpCategoriesToYouzanGroups(options);
          return Response.json({ ok: true, data: result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Response.json({ ok: false, error: message }, { status: 400 });
        }
      },
    },
  },
});
