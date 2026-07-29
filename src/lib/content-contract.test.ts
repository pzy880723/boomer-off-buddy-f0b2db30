import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { EditorialContentSchema, canTransitionContentStatus } from "./content-contract";
import { canManageEditorialContent } from "./content-permissions";

const contentId = "d04f1814-e62c-49c4-a6b7-f93d747c4c52";

test("parses a published vertical video with canonical relations", () => {
  const item = EditorialContentSchema.parse({
    id: contentId,
    slug: "tin-robot-story",
    type: "vertical_video",
    status: "published",
    title: "铁皮机器人的玻璃眼睛",
    summary: "一段关于机械玩具的短片。",
    body: null,
    cover_url: "https://cdn.boomeroff.top/covers/tin-robot.jpg",
    video_url: "https://cdn.boomeroff.top/video/tin-robot.mp4",
    aspect_ratio: 0.5625,
    duration_seconds: 48,
    source: {
      id: "boomer-editorial",
      name: "BOOMER 编辑部",
      kind: "boomer_original",
      label: "BOOMER 原创",
      original_url: null,
      ai_summarized: false,
    },
    channel_ids: ["toys"],
    keywords: ["铁皮玩具", "机器人"],
    related_product_ids: [],
    related_knowledge_ids: [],
    relations: [{ entity_type: "facet", entity_key: "ip.astroboy", label: "铁臂阿童木" }],
    published_at: "2026-07-29T10:00:00.000Z",
    scheduled_at: null,
    engagement: {
      like_count: 10,
      comment_count: 2,
      share_count: 1,
      liked: false,
      bookmarked: false,
    },
  });

  assert.equal(item.id, contentId);
  assert.equal(item.type, "vertical_video");
  assert.equal(item.relations[0]?.entity_key, "ip.astroboy");
});

test("rejects article content without body text", () => {
  const result = EditorialContentSchema.safeParse({
    id: contentId,
    slug: "empty-article",
    type: "article",
    status: "draft",
    title: "空文章",
    summary: "缺少正文",
    body: null,
    cover_url: null,
    video_url: null,
    aspect_ratio: 1.3333,
    duration_seconds: 0,
    source: {
      id: "boomer-editorial",
      name: "BOOMER 编辑部",
      kind: "boomer_original",
      label: "BOOMER 原创",
      original_url: null,
      ai_summarized: false,
    },
    channel_ids: [],
    keywords: [],
    related_product_ids: [],
    related_knowledge_ids: [],
    relations: [],
    published_at: null,
    scheduled_at: null,
    engagement: {
      like_count: 0,
      comment_count: 0,
      share_count: 0,
      liked: false,
      bookmarked: false,
    },
  });

  assert.equal(result.success, false);
});

test("allows review publishing and rejects archived rollback", () => {
  assert.equal(canTransitionContentStatus("pending_review", "published"), true);
  assert.equal(canTransitionContentStatus("archived", "draft"), false);
});

test("only headquarters roles can manage editorial content", () => {
  assert.equal(canManageEditorialContent(["super_admin"]), true);
  assert.equal(canManageEditorialContent(["hq_operator"]), true);
  assert.equal(canManageEditorialContent(["store_manager"]), false);
  assert.equal(canManageEditorialContent(["store_staff"]), false);
  assert.equal(canManageEditorialContent([]), false);
});

test("content migration keeps engagement counters atomic", async () => {
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/20260729090000_content_operations_platform.sql",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(migration, /tg_editorial_content_action_count/);
  assert.match(migration, /tg_editorial_content_comment_count/);
  assert.match(migration, /increment_editorial_content_share/);
  assert.match(migration, /share_count\s*=\s*editorial_content_engagement\.share_count\s*\+\s*1/);
});
