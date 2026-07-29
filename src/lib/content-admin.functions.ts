import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  changeEditorialContentStatusAdmin,
  findEditorialContentAdmin,
  findOfficialKnowledgeAdmin,
  listEditorialContentAdmin,
  listOfficialKnowledgeAdmin,
  saveEditorialContentAdmin,
  saveOfficialKnowledgeAdmin,
} from "./content-supabase.server";
import {
  ContentStatusSchema,
  ContentTypeSchema,
  OfficialKnowledgeTypeSchema,
} from "./content-contract";
import { canManageEditorialContent } from "./content-permissions";

type ContentAdminContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

async function assertContentOperator(context: ContentAdminContext) {
  const { data, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  if (error) throw new Error(error.message);
  if (!canManageEditorialContent((data ?? []).map((row) => row.role))) {
    throw new Response("仅总部运营账号可管理资讯与官方知识", { status: 403 });
  }
}

const SourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  original_url: z.string().url().nullable(),
  ai_summarized: z.boolean(),
});

const EditorialInputSchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().trim().min(1),
  type: ContentTypeSchema,
  status: ContentStatusSchema.default("draft"),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  body: z.string().trim().nullable(),
  cover_url: z.string().url().nullable(),
  video_url: z.string().url().nullable(),
  aspect_ratio: z.number().positive(),
  duration_seconds: z.number().int().nonnegative(),
  source: SourceSchema,
  channel_ids: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  related_product_ids: z.array(z.string().uuid()),
  related_knowledge_ids: z.array(z.string().uuid()),
  scheduled_at: z.string().datetime().nullable(),
  published_at: z.string().datetime().nullable(),
});

const RelationInputSchema = z.object({
  entity_type: z.enum(["primary_category", "brand", "facet", "product"]),
  entity_key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  is_primary: z.boolean(),
});

const KnowledgeInputSchema = z.object({
  id: z.string().uuid().optional(),
  slug: z.string().trim().min(1),
  type: OfficialKnowledgeTypeSchema,
  status: ContentStatusSchema.default("draft"),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  story: z.string().trim().min(1),
  evidence: z.array(z.string().min(1)),
  care_advice: z.array(z.string().min(1)),
  cover_url: z.string().url().nullable(),
  keywords: z.array(z.string().min(1)),
  published_at: z.string().datetime().nullable(),
  relations: z.array(RelationInputSchema).min(1),
});

export const listEditorialContentFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertContentOperator(context);
    return listEditorialContentAdmin();
  });

export const getEditorialContentFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertContentOperator(context);
    return findEditorialContentAdmin(data.id);
  });

export const saveEditorialContentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => EditorialInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertContentOperator(context);
    return saveEditorialContentAdmin(data);
  });

export const changeEditorialContentStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), status: ContentStatusSchema }).parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertContentOperator(context);
    return changeEditorialContentStatusAdmin(data.id, data.status);
  });

export const listOfficialKnowledgeFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertContentOperator(context);
    return listOfficialKnowledgeAdmin();
  });

export const getOfficialKnowledgeFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertContentOperator(context);
    return findOfficialKnowledgeAdmin(data.id);
  });

export const saveOfficialKnowledgeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => KnowledgeInputSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertContentOperator(context);
    return saveOfficialKnowledgeAdmin(data);
  });
