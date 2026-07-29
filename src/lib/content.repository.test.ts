import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryContentRepository } from "./content.repository";
import type { EditorialContent } from "./content-contract";

function item(
  id: string,
  status: EditorialContent["status"],
  type: EditorialContent["type"],
): EditorialContent {
  return {
    id,
    slug: id,
    type,
    status,
    title: id,
    summary: `${id} summary`,
    body: type === "article" ? `${id} body` : null,
    cover_url: null,
    video_url: type === "article" ? null : `https://cdn.example.com/${id}.mp4`,
    aspect_ratio: type === "vertical_video" ? 9 / 16 : 16 / 9,
    duration_seconds: type === "article" ? 0 : 30,
    source: {
      id: "boomer-editorial",
      name: "BOOMER 编辑部",
      kind: "boomer_original",
      label: "BOOMER 原创",
      original_url: null,
      ai_summarized: false,
    },
    channel_ids: ["recommended"],
    keywords: [],
    related_product_ids: [],
    related_knowledge_ids: [],
    relations: [],
    published_at: status === "published" ? "2026-07-29T10:00:00.000Z" : null,
    scheduled_at: null,
    engagement: {
      like_count: 0,
      comment_count: 0,
      share_count: 0,
      liked: false,
      bookmarked: false,
    },
  };
}

test("public feed excludes drafts and filters by type", async () => {
  const repository = new InMemoryContentRepository([
    item("published-video", "published", "vertical_video"),
    item("draft-video", "draft", "vertical_video"),
    item("published-article", "published", "article"),
  ]);

  const page = await repository.listPublic({
    type: "vertical_video",
    page: 1,
    pageSize: 20,
  });

  assert.deepEqual(
    page.items.map((entry) => entry.id),
    ["published-video"],
  );
  assert.equal(page.total, 1);
});

test("status changes follow the approved lifecycle", async () => {
  const repository = new InMemoryContentRepository([item("draft-article", "draft", "article")]);

  await repository.changeStatus("draft-article", "pending_review");
  await repository.changeStatus("draft-article", "published");

  assert.equal((await repository.findById("draft-article")).status, "published");
  await assert.rejects(
    () => repository.changeStatus("draft-article", "draft"),
    /Invalid content status transition/,
  );
});
