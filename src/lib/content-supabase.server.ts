import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  canTransitionContentStatus,
  ContentStatusSchema,
  EditorialContentSchema,
  OfficialKnowledgeSchema,
  type ContentStatus,
  type EditorialContent,
  type OfficialKnowledge,
} from "./content-contract";
import type { PublicContentQuery } from "./content.repository";
import {
  normalizePublicContentSource,
  normalizePublicContentTimestamp,
} from "./content-public";

type LooseQuery = {
  select(columns?: string, options?: Record<string, unknown>): LooseQuery;
  eq(column: string, value: unknown): LooseQuery;
  contains(column: string, value: unknown): LooseQuery;
  or(expression: string): LooseQuery;
  order(column: string, options?: Record<string, unknown>): LooseQuery;
  range(from: number, to: number): PromiseLike<LooseResult>;
  maybeSingle(): PromiseLike<LooseResult>;
  insert(value: unknown): LooseQuery;
  upsert(value: unknown, options?: Record<string, unknown>): LooseQuery;
  update(value: unknown): LooseQuery;
  delete(): LooseQuery;
};

type LooseResult = {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
};

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function table(name: string): LooseQuery {
  return supabaseAdmin.from(name as never) as unknown as LooseQuery;
}

function asRecord(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function toEditorialContent(
  value: unknown,
  relations: unknown[] = [],
  engagement?: unknown,
): EditorialContent {
  const row = asRecord(value);
  const engagementRow = asRecord(engagement);
  return EditorialContentSchema.parse({
    ...row,
    source: normalizePublicContentSource(row.source),
    published_at: normalizePublicContentTimestamp(row.published_at),
    scheduled_at: normalizePublicContentTimestamp(row.scheduled_at),
    relations: relations.map((relation) => {
      const entry = asRecord(relation);
      return {
        entity_type: entry.entity_type,
        entity_key: entry.entity_key,
        label: entry.label,
      };
    }),
    engagement: {
      like_count: engagementRow.like_count ?? 0,
      comment_count: engagementRow.comment_count ?? 0,
      share_count: engagementRow.share_count ?? 0,
      liked: false,
      bookmarked: false,
    },
  });
}

async function loadRelations(contentId: string) {
  const { data, error } = await table("editorial_content_relations")
    .select("entity_type,entity_key,label")
    .eq("content_id", contentId)
    .range(0, 200);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

async function loadEngagement(contentId: string) {
  const { data, error } = await table("editorial_content_engagement")
    .select("like_count,comment_count,share_count,bookmark_count")
    .eq("content_id", contentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function listPublicContent(query: PublicContentQuery) {
  let request = table("editorial_contents")
    .select("*", { count: "exact" })
    .eq("status", "published");
  if (query.type) request = request.eq("type", query.type);
  if (query.channelId) {
    request = request.contains("channel_ids", [query.channelId]);
  }
  if (query.query) {
    const escaped = query.query.replaceAll(",", " ").replaceAll("%", "");
    request = request.or(`title.ilike.%${escaped}%,summary.ilike.%${escaped}%`);
  }
  const start = (query.page - 1) * query.pageSize;
  const { data, error, count } = await request
    .order("published_at", { ascending: false })
    .range(start, start + query.pageSize - 1);
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  const items = await Promise.all(
    rows.map(async (row) => {
      const id = String(asRecord(row).id);
      return toEditorialContent(row, await loadRelations(id), await loadEngagement(id));
    }),
  );
  return { items, total: count ?? items.length };
}

export async function findPublicContent(id: string) {
  const { data, error } = await table("editorial_contents")
    .select("*")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return toEditorialContent(data, await loadRelations(id), await loadEngagement(id));
}

export async function listPublicComments(contentId: string) {
  const { data, error } = await table("editorial_content_comments")
    .select("id,author_name,body,created_at")
    .eq("content_id", contentId)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .range(0, 99);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

export async function addPendingComment(contentId: string, authorName: string, body: string) {
  const { data, error } = await table("editorial_content_comments")
    .insert({
      content_id: contentId,
      author_name: authorName,
      body,
      status: "pending_review",
    })
    .select("id,author_name,body,status,created_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function toggleContentAction(
  contentId: string,
  userKey: string,
  action: "like" | "bookmark",
) {
  const existing = await table("editorial_content_user_actions")
    .select("content_id")
    .eq("content_id", contentId)
    .eq("user_key", userKey)
    .eq("action", action)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) {
    const removed = await table("editorial_content_user_actions")
      .delete()
      .eq("content_id", contentId)
      .eq("user_key", userKey)
      .eq("action", action)
      .maybeSingle();
    if (removed.error) throw new Error(removed.error.message);
    return false;
  }
  const inserted = await table("editorial_content_user_actions")
    .insert({ content_id: contentId, user_key: userKey, action })
    .select("content_id")
    .maybeSingle();
  if (inserted.error) throw new Error(inserted.error.message);
  return true;
}

export async function incrementShare(contentId: string) {
  const { data, error } = await supabaseAdmin.rpc(
    "increment_editorial_content_share" as never,
    { p_content_id: contentId } as never,
  );
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

export async function listPublicOfficialKnowledge(entityType?: string, entityId?: string) {
  const request = table("official_knowledge_entries").select("*").eq("status", "published");
  const { data, error } = await request.order("published_at", { ascending: false }).range(0, 99);
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  const entries = [];
  for (const row of rows) {
    const id = String(asRecord(row).id);
    const relationsResult = await table("official_knowledge_relations")
      .select("entity_type,entity_key,label,is_primary")
      .eq("knowledge_id", id)
      .range(0, 99);
    if (relationsResult.error) throw new Error(relationsResult.error.message);
    const relations = Array.isArray(relationsResult.data) ? relationsResult.data.map(asRecord) : [];
    if (
      entityType &&
      entityId &&
      !relations.some(
        (relation) => relation.entity_type === entityType && relation.entity_key === entityId,
      )
    ) {
      continue;
    }
    const primary = relations.find((relation) => relation.is_primary === true) ?? relations[0];
    if (!primary) continue;
    entries.push(
      OfficialKnowledgeSchema.parse({
        ...asRecord(row),
        primary_relation: primary,
        related_relations: relations.filter((relation) => relation !== primary),
      }),
    );
  }
  return entries;
}

export async function findPublicOfficialKnowledge(id: string) {
  const entries = await listPublicOfficialKnowledge();
  return entries.find((entry) => entry.id === id) ?? null;
}

export async function listEditorialContentAdmin() {
  const { data, error } = await table("editorial_contents")
    .select("*")
    .order("updated_at", { ascending: false })
    .range(0, 499);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data.map(asRecord) : [];
}

export async function findEditorialContentAdmin(id: string) {
  const { data, error } = await table("editorial_contents").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return asRecord(data);
}

export async function saveEditorialContentAdmin(input: Record<string, unknown>) {
  const { id: inputId, ...values } = input;
  const id = typeof inputId === "string" && inputId ? inputId : undefined;
  const payload: Record<string, unknown> = {
    ...values,
    updated_at: new Date().toISOString(),
  };
  const request = id
    ? table("editorial_contents").update(payload).eq("id", id)
    : table("editorial_contents").insert(payload);
  const { data, error } = await request.select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return asRecord(data);
}

export async function changeEditorialContentStatusAdmin(id: string, nextStatus: ContentStatus) {
  const current = await findEditorialContentAdmin(id);
  if (!current) throw new Error("内容不存在");
  const currentStatus = ContentStatusSchema.parse(current.status);
  if (!canTransitionContentStatus(currentStatus, nextStatus)) {
    throw new Error(`Invalid content status transition: ${currentStatus} -> ${nextStatus}`);
  }
  const patch: Record<string, unknown> = {
    status: nextStatus,
    updated_at: new Date().toISOString(),
  };
  if (nextStatus === "published" && !current.published_at) {
    patch.published_at = new Date().toISOString();
  }
  const { data, error } = await table("editorial_contents")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return asRecord(data);
}

export async function listOfficialKnowledgeAdmin() {
  const { data, error } = await table("official_knowledge_entries")
    .select("*")
    .order("updated_at", { ascending: false })
    .range(0, 499);
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data.map(asRecord) : [];
}

export async function findOfficialKnowledgeAdmin(id: string) {
  const { data, error } = await table("official_knowledge_entries")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const relationsResult = await table("official_knowledge_relations")
    .select("entity_type,entity_key,label,is_primary")
    .eq("knowledge_id", id)
    .range(0, 99);
  if (relationsResult.error) throw new Error(relationsResult.error.message);
  const record: JsonObject = {
    ...asRecord(data),
    relations: Array.isArray(relationsResult.data) ? relationsResult.data.map(asRecord) : [],
  };
  return record;
}

export async function saveOfficialKnowledgeAdmin(input: Record<string, unknown>) {
  const { id: inputId, relations: inputRelations, ...values } = input;
  const id = typeof inputId === "string" && inputId ? inputId : undefined;
  const relations = Array.isArray(inputRelations) ? inputRelations : [];
  const payload: Record<string, unknown> = {
    ...values,
    updated_at: new Date().toISOString(),
  };
  const request = id
    ? table("official_knowledge_entries").update(payload).eq("id", id)
    : table("official_knowledge_entries").insert(payload);
  const { data, error } = await request.select("*").maybeSingle();
  if (error) throw new Error(error.message);
  const saved = asRecord(data);
  const knowledgeId = String(saved.id);
  const removed = await table("official_knowledge_relations")
    .delete()
    .eq("knowledge_id", knowledgeId)
    .maybeSingle();
  if (removed.error) throw new Error(removed.error.message);
  if (relations.length > 0) {
    const inserted = await table("official_knowledge_relations")
      .insert(
        relations.map((relation) => ({
          ...asRecord(relation),
          knowledge_id: knowledgeId,
        })),
      )
      .select("id")
      .range(0, relations.length - 1);
    if (inserted.error) throw new Error(inserted.error.message);
  }
  return findOfficialKnowledgeAdmin(knowledgeId);
}
