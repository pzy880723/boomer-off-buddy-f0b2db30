import { z } from "zod";

export const ContentTypeSchema = z.enum(["article", "horizontal_video", "vertical_video"]);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const ContentStatusSchema = z.enum([
  "draft",
  "pending_review",
  "scheduled",
  "published",
  "archived",
]);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

export const ContentSourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum([
    "boomer_original",
    "boomer_store",
    "brand_official",
    "open_collection",
    "external_summary",
  ]),
  label: z.string().min(1),
  original_url: z.string().url().nullable(),
  ai_summarized: z.boolean(),
});

export const CanonicalRelationSchema = z.object({
  entity_type: z.enum(["primary_category", "brand", "facet", "product", "official_knowledge"]),
  entity_key: z.string().min(1),
  label: z.string().min(1),
});

export const ContentEngagementSchema = z.object({
  like_count: z.number().int().nonnegative(),
  comment_count: z.number().int().nonnegative(),
  share_count: z.number().int().nonnegative(),
  liked: z.boolean(),
  bookmarked: z.boolean(),
});

export const EditorialContentSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string().min(1),
    type: ContentTypeSchema,
    status: ContentStatusSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    body: z.string().min(1).nullable(),
    cover_url: z.string().url().nullable(),
    video_url: z.string().url().nullable(),
    aspect_ratio: z.number().positive(),
    duration_seconds: z.number().int().nonnegative(),
    source: ContentSourceSchema,
    channel_ids: z.array(z.string().min(1)),
    keywords: z.array(z.string().min(1)),
    related_product_ids: z.array(z.string().uuid()),
    related_knowledge_ids: z.array(z.string().uuid()),
    relations: z.array(CanonicalRelationSchema),
    published_at: z.string().datetime().nullable(),
    scheduled_at: z.string().datetime().nullable(),
    engagement: ContentEngagementSchema,
  })
  .superRefine((content, context) => {
    if (content.type === "article" && !content.body) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "Article content requires body text",
      });
    }
    if (content.type !== "article" && !content.video_url) {
      context.addIssue({
        code: "custom",
        path: ["video_url"],
        message: "Video content requires a video URL",
      });
    }
  });
export type EditorialContent = z.infer<typeof EditorialContentSchema>;

const transitions: Record<ContentStatus, ReadonlySet<ContentStatus>> = {
  draft: new Set(["pending_review", "archived"]),
  pending_review: new Set(["draft", "scheduled", "published", "archived"]),
  scheduled: new Set(["draft", "published", "archived"]),
  published: new Set(["archived"]),
  archived: new Set(),
};

export function canTransitionContentStatus(from: ContentStatus, to: ContentStatus): boolean {
  return from === to || transitions[from].has(to);
}

export const OfficialKnowledgeTypeSchema = z.enum([
  "brand",
  "category",
  "ip",
  "character_series",
  "era_style",
  "material_craft",
  "origin_kiln",
  "collection_care",
]);

export const OfficialKnowledgeSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  type: OfficialKnowledgeTypeSchema,
  status: ContentStatusSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  story: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  care_advice: z.array(z.string().min(1)),
  cover_url: z.string().url().nullable(),
  keywords: z.array(z.string().min(1)),
  primary_relation: CanonicalRelationSchema,
  related_relations: z.array(CanonicalRelationSchema),
  published_at: z.string().datetime().nullable(),
});
export type OfficialKnowledge = z.infer<typeof OfficialKnowledgeSchema>;
