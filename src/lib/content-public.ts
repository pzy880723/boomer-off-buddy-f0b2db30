import {
  ContentSourceSchema,
  ContentTypeSchema,
  type EditorialContent,
} from "./content-contract";
import type { PublicContentQuery } from "./content.repository";

export function normalizePublicContentTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizePublicContentSource(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const parsed = ContentSourceSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const generated = typeof source["generator"] === "string";
  return ContentSourceSchema.parse({
    id: typeof source["id"] === "string" && source["id"] ? source["id"] : "boomer-handheld-ai",
    name:
      typeof source["name"] === "string" && source["name"]
        ? source["name"]
        : "BOOMER OFF 编辑部",
    kind: "boomer_store",
    label:
      typeof source["label"] === "string" && source["label"]
        ? source["label"]
        : "中古买手推荐",
    original_url: typeof source["original_url"] === "string" ? source["original_url"] : null,
    ai_summarized:
      typeof source["ai_summarized"] === "boolean" ? source["ai_summarized"] : generated,
  });
}

export function parsePublicContentQuery(url: URL): PublicContentQuery {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const requestedPageSize = Number.parseInt(url.searchParams.get("page_size") ?? "20", 10) || 20;
  const rawType = url.searchParams.get("type");
  const parsedType = ContentTypeSchema.safeParse(rawType);
  return {
    type: parsedType.success ? parsedType.data : undefined,
    channelId: url.searchParams.get("channel")?.trim() || undefined,
    query: url.searchParams.get("q")?.trim() ?? "",
    page,
    pageSize: Math.min(50, Math.max(1, requestedPageSize)),
  };
}

export function toPublicContentDto(content: EditorialContent) {
  return {
    id: content.id,
    slug: content.slug,
    type: content.type,
    title: content.title,
    summary: content.summary,
    body: content.body,
    source: content.source,
    media: {
      cover_url: content.cover_url,
      video_url: content.video_url,
      aspect_ratio: content.aspect_ratio,
      duration_seconds: content.duration_seconds,
    },
    channel_ids: content.channel_ids,
    keywords: content.keywords,
    related_product_ids: content.related_product_ids,
    related_knowledge_ids: content.related_knowledge_ids,
    relations: content.relations,
    published_at: content.published_at,
    engagement: content.engagement,
  };
}
