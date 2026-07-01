import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type CategoryRow = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  youzan_hq_category_id: number | null;
  youzan_shop_id: string | null;
  synced_at: string | null;
};

const SELECT_COLS =
  "id, code, name, parent_id, sort_order, is_active, is_system, youzan_hq_category_id, youzan_shop_id, synced_at";

/* ---------- 列表（所有登录用户）---------- */
export const listCategories = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("inv_categories" as never)
      .select(SELECT_COLS)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as unknown as CategoryRow[] };
  });

/* ---------- 新增 / 更新 ---------- */
const UpsertInput = z.object({
  id: z.string().uuid().optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/u, "code 仅支持字母、数字、下划线"),
  name: z.string().trim().min(1).max(64),
  parent_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).max(9999).default(0),
  is_active: z.boolean().default(true),
});
export const upsertCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => UpsertInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const payload = {
      code: data.code,
      name: data.name,
      parent_id: data.parent_id ?? null,
      sort_order: data.sort_order ?? 0,
      is_active: data.is_active,
    };
    if (data.id) {
      const { error } = await supabase
        .from("inv_categories" as never)
        .update(payload as never)
        .eq("id", data.id);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: ins, error } = await supabase
      .from("inv_categories" as never)
      .insert(payload as never)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: (ins as { id: string }).id };
  });

/* ---------- 停用 / 删除 ---------- */
export const setCategoryActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z.object({ id: z.string().uuid(), is_active: z.boolean() }).parse(i),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("inv_categories" as never)
      .update({ is_active: data.is_active } as never)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ id: z.string().uuid() }).parse(i))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: cat, error: cErr } = await supabase
      .from("inv_categories" as never)
      .select("code, is_system")
      .eq("id", data.id)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!cat) throw new Error("分类不存在");
    const row = cat as { code: string; is_system: boolean };
    if (row.is_system) throw new Error("系统种子分类不可删除，可停用");
    const { count } = await supabase
      .from("inv_skus")
      .select("id", { count: "exact", head: true })
      .eq("category", row.code);
    if ((count ?? 0) > 0) throw new Error(`该分类下还有 ${count} 个商品，不能删除，请先停用`);
    const { error } = await supabase
      .from("inv_categories" as never)
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ---------- 有赞同步（预览 / 采纳）---------- */
type YzCategory = { id: number; name: string; parent_id: number | null; sort_order?: number };

async function fetchYouzanHqCategories(): Promise<{
  api: string;
  shop_id: string;
  rows: YzCategory[];
}> {
  const { getHqShop, ensureAccessToken, callYouzanApiVerbose } = await import(
    "@/lib/youzan.functions"
  );
  const hq = await getHqShop();
  const token = await ensureAccessToken(hq);

  // 试多个已知接口
  const attempts: { method: string; version: string; extract: (p: unknown) => YzCategory[] }[] = [
    {
      method: "youzan.retail.product.standardcategory.get",
      version: "3.0.0",
      extract: (p) => normalizeCats((p as { categories?: unknown; data?: unknown })),
    },
    {
      method: "youzan.itemcategories.get",
      version: "3.0.0",
      extract: (p) => normalizeCats(p as { categories?: unknown }),
    },
  ];
  const errs: string[] = [];
  for (const a of attempts) {
    try {
      const { payload } = await callYouzanApiVerbose({
        accessToken: token,
        method: a.method,
        version: a.version,
      });
      const rows = a.extract(payload);
      if (rows.length > 0) return { api: a.method, shop_id: hq.id, rows };
      errs.push(`${a.method}: 返回空`);
    } catch (e) {
      errs.push(`${a.method}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`拉取有赞分类失败：\n${errs.join("\n")}`);
}

function normalizeCats(payload: unknown): YzCategory[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const raw =
    (p.categories as unknown[]) ??
    (p.category_list as unknown[]) ??
    ((p.data as { categories?: unknown[] } | undefined)?.categories as unknown[]) ??
    [];
  const out: YzCategory[] = [];
  const walk = (arr: unknown[], pid: number | null) => {
    for (const it of arr) {
      const o = it as Record<string, unknown>;
      const id = Number(o.category_id ?? o.id ?? o.cid);
      const name = String(o.name ?? o.category_name ?? "").trim();
      if (!id || !name) continue;
      out.push({ id, name, parent_id: pid, sort_order: Number(o.sort_order ?? 0) });
      const children = (o.children as unknown[]) ?? (o.sub_categories as unknown[]);
      if (Array.isArray(children) && children.length > 0) walk(children, id);
    }
  };
  walk(raw as unknown[], null);
  return out;
}

function pinyinCode(name: string, yzId: number): string {
  // 简易兜底：取字母数字保留原样，其它用有赞 id 尾数
  const ascii = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (ascii.length >= 2) return ascii.slice(0, 8);
  return `YZ${String(yzId).slice(-4)}`;
}

export const previewYouzanCategorySync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { rows: yz, api, shop_id } = await fetchYouzanHqCategories();
    const { data: existing, error } = await context.supabase
      .from("inv_categories" as never)
      .select(SELECT_COLS);
    if (error) throw new Error(error.message);
    const local = (existing ?? []) as unknown as CategoryRow[];
    const byYz = new Map(local.filter((r) => r.youzan_hq_category_id).map((r) => [r.youzan_hq_category_id!, r]));

    const toAdd: { yz: YzCategory; suggest_code: string }[] = [];
    const toUpdate: { local: CategoryRow; yz: YzCategory }[] = [];
    for (const y of yz) {
      const cur = byYz.get(y.id);
      if (!cur) {
        toAdd.push({ yz: y, suggest_code: pinyinCode(y.name, y.id) });
      } else if (cur.name !== y.name) {
        toUpdate.push({ local: cur, yz: y });
      }
    }
    // 已经映射但有赞已删除的
    const yzIds = new Set(yz.map((y) => y.id));
    const toDeactivate = local.filter(
      (r) => r.youzan_hq_category_id != null && !yzIds.has(r.youzan_hq_category_id) && r.is_active,
    );
    return { api, shop_id, to_add: toAdd, to_update: toUpdate, to_deactivate: toDeactivate };
  });

const ApplyInput = z.object({
  shop_id: z.string().uuid(),
  add: z
    .array(
      z.object({
        youzan_hq_category_id: z.number().int(),
        name: z.string(),
        code: z.string().min(1),
      }),
    )
    .default([]),
  update: z.array(z.object({ id: z.string().uuid(), name: z.string() })).default([]),
  deactivate: z.array(z.string().uuid()).default([]),
});
export const applyYouzanCategorySync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => ApplyInput.parse(i))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const now = new Date().toISOString();
    let addedN = 0;
    let updatedN = 0;
    let deactivatedN = 0;

    // ---- add
    for (const a of data.add) {
      // code 冲突自动加后缀
      let code = a.code;
      for (let n = 2; n < 20; n++) {
        const { data: dup } = await supabase
          .from("inv_categories" as never)
          .select("id")
          .eq("code", code)
          .maybeSingle();
        if (!dup) break;
        code = `${a.code}${n}`;
      }
      const { error } = await supabase.from("inv_categories" as never).insert({
        code,
        name: a.name,
        youzan_hq_category_id: a.youzan_hq_category_id,
        youzan_shop_id: data.shop_id,
        synced_at: now,
        sort_order: 500,
      } as never);
      if (error) throw new Error(error.message);
      addedN++;
    }
    // ---- update
    for (const u of data.update) {
      const { error } = await supabase
        .from("inv_categories" as never)
        .update({ name: u.name, synced_at: now } as never)
        .eq("id", u.id);
      if (error) throw new Error(error.message);
      updatedN++;
    }
    // ---- deactivate
    if (data.deactivate.length > 0) {
      const { error } = await supabase
        .from("inv_categories" as never)
        .update({ is_active: false, synced_at: now } as never)
        .in("id", data.deactivate);
      if (error) throw new Error(error.message);
      deactivatedN = data.deactivate.length;
    }
    return { added: addedN, updated: updatedN, deactivated: deactivatedN };
  });
