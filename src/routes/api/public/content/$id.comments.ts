import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { addPendingComment, listPublicComments } from "@/lib/content-supabase.server";

const CommentSchema = z.object({
  author_name: z.string().trim().min(1).max(40).default("BOOMER 用户"),
  body: z.string().trim().min(1).max(500),
});

export const Route = createFileRoute("/api/public/content/$id/comments")({
  server: {
    handlers: {
      GET: async ({ params }) =>
        Response.json({
          ok: true,
          data: await listPublicComments(params.id),
        }),
      POST: async ({ params, request }) => {
        const parsed = CommentSchema.safeParse(await request.json());
        if (!parsed.success) {
          return Response.json({ ok: false, error: "评论内容不符合要求" }, { status: 400 });
        }
        return Response.json({
          ok: true,
          data: await addPendingComment(params.id, parsed.data.author_name, parsed.data.body),
        });
      },
    },
  },
});
