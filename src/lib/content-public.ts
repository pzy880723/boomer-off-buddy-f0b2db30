import { ContentTypeSchema, type EditorialContent } from "./content-contract";
import type { PublicContentQuery } from "./content.repository";

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
