import { createFileRoute } from "@tanstack/react-router";
import { listPublicContent } from "@/lib/content-supabase.server";
import { parsePublicContentQuery, toPublicContentDto } from "@/lib/content-public";

export const Route = createFileRoute("/api/public/content/feed")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const query = parsePublicContentQuery(new URL(request.url));
          const page = await listPublicContent(query);
          return response({
            ok: true,
            data: page.items.map(toPublicContentDto),
            pagination: {
              page: query.page,
              page_size: query.pageSize,
              total: page.total,
            },
          });
        } catch (error) {
          return response(
            { ok: false, error: error instanceof Error ? error.message : "内容读取失败" },
            500,
          );
        }
      },
    },
  },
});

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
