import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizePublicContentSource,
  normalizePublicContentTimestamp,
  parsePublicContentQuery,
  toPublicContentDto,
} from "./content-public";
import type { EditorialContent } from "./content-contract";

const entry: EditorialContent = {
  id: "d04f1814-e62c-49c4-a6b7-f93d747c4c52",
  slug: "robot",
  type: "vertical_video",
  status: "published",
  title: "铁皮机器人",
  summary: "一段玩具故事",
  body: null,
  cover_url: null,
  video_url: "https://cdn.example.com/robot.mp4",
  aspect_ratio: 9 / 16,
  duration_seconds: 48,
  source: {
    id: "boomer",
    name: "BOOMER 编辑部",
    kind: "boomer_original",
    label: "原创",
    original_url: null,
    ai_summarized: false,
  },
  channel_ids: ["toys"],
  keywords: ["机器人"],
  related_product_ids: [],
  related_knowledge_ids: [],
  relations: [],
  published_at: "2026-07-29T10:00:00.000Z",
  scheduled_at: null,
  engagement: {
    like_count: 4,
    comment_count: 1,
    share_count: 2,
    liked: false,
    bookmarked: false,
  },
};

test("normalizes bounded feed query parameters", () => {
  const query = parsePublicContentQuery(
    new URL(
      "https://example.com/api/public/content/feed?type=vertical_video&page=2&page_size=500&channel=toys",
    ),
  );

  assert.deepEqual(query, {
    type: "vertical_video",
    channelId: "toys",
    query: "",
    page: 2,
    pageSize: 50,
  });
});

test("public dto exposes app fields without internal status", () => {
  const dto = toPublicContentDto(entry);

  assert.equal(dto.id, entry.id);
  assert.equal(dto.media.video_url, entry.video_url);
  assert.equal("status" in dto, false);
  assert.equal("reviewed_by" in dto, false);
});

test("normalizes PostgreSQL timestamps for the public contract", () => {
  assert.equal(
    normalizePublicContentTimestamp("2026-08-03 17:58:01.676+00"),
    "2026-08-03T17:58:01.676Z",
  );
  assert.equal(normalizePublicContentTimestamp(null), null);
});

test("keeps legacy handheld AI sources readable", () => {
  assert.deepEqual(
    normalizePublicContentSource({
      generator: "handheld.content.generate-from-sku",
      model: "google/gemini-3.6-flash",
    }),
    {
      id: "boomer-handheld-ai",
      name: "BOOMER OFF 编辑部",
      kind: "boomer_store",
      label: "中古买手推荐",
      original_url: null,
      ai_summarized: true,
    },
  );
});
