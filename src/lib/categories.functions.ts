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
  youzan_hq_parent_id: number | null;
  youzan_shop_id: string | null;
  synced_at: string | null;
};

const SELECT_COLS =
  "id, code, name, parent_id, sort_order, is_active, is_system, youzan_hq_category_id, youzan_hq_parent_id, youzan_shop_id, synced_at";

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
  notes: string[];
}> {
  const { getHqShop, ensureAccessToken, callYouzanApiVerbose } = await import(
    "@/lib/youzan.functions"
  );
  const hq = await getHqShop();
  const token = await ensureAccessToken(hq);
  const notes: string[] = [];

  // 一级列表接口候选
  const rootAttempts: {
    method: string;
    version: string;
    extract: (p: unknown) => YzCategory[];
  }[] = [
    {
      method: "youzan.retail.product.standardcategory.get",
      version: "3.0.0",
      extract: (p) => normalizeCats(p),
    },
    {
      method: "youzan.itemcategories.get",
      version: "3.0.0",
      extract: (p) => normalizeCats(p),
    },
  ];
  const errs: string[] = [];
  let usedApi = "";
  let allRows: YzCategory[] = [];
  for (const a of rootAttempts) {
    try {
      const { payload } = await callYouzanApiVerbose({
        accessToken: token,
        method: a.method,
        version: a.version,
      });
      const rows = a.extract(payload);
      if (rows.length > 0) {
        usedApi = a.method;
        allRows = rows;
        break;
      }
      errs.push(`${a.method}: 返回空`);
    } catch (e) {
      errs.push(`${a.method}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (allRows.length === 0) throw new Error(`拉取有赞分类失败：\n${errs.join("\n")}`);

  // 若接口本身没返回子分类（parent_id 全为 null），逐个一级 by-parent 补拉
  const hasChildren = allRows.some((r) => r.parent_id != null);
  if (!hasChildren) {
    const roots = allRows.filter((r) => r.parent_id == null);
    const childAttempts = [
      { method: "youzan.itemcategories.get.byparentcid", version: "3.0.0" },
      { method: "youzan.retail.product.category.get", version: "3.0.0" },
    ];
    let childApi = "";
    let ok = 0;
    for (const root of roots) {
      let picked: YzCategory[] | null = null;
      for (const a of childAttempts) {
        try {
          const { payload } = await callYouzanApiVerbose({
            accessToken: token,
            method: a.method,
            version: a.version,
            params: { parent_cid: root.id, parent_id: root.id },
          });
          const kids = normalizeCats(payload, root.id);
          if (kids.length > 0) {
            picked = kids;
            childApi = a.method;
            break;
          }
        } catch {
          /* try next */
        }
      }
      if (picked) {
        // 去重（child API 有时把父自己也带回来）
        const rootSet = new Set(allRows.map((r) => r.id));
        for (const k of picked) {
          if (k.id === root.id) continue;
          if (rootSet.has(k.id)) continue;
          allRows.push({ ...k, parent_id: root.id });
        }
        ok++;
      }
    }
    if (ok > 0) notes.push(`已通过 ${childApi} 补拉 ${ok} 个一级的子类目`);
    else notes.push("未能获取二级分类（可能授权无权限或店铺无子分类）");
  }
  return { api: usedApi, shop_id: hq.id, rows: allRows, notes };
}

function normalizeCats(payload: unknown, defaultParent: number | null = null): YzCategory[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const raw =
    (p.categories as unknown[]) ??
    (p.category_list as unknown[]) ??
    (p.sub_categories as unknown[]) ??
    (p.children as unknown[]) ??
    ((p.data as { categories?: unknown[]; category_list?: unknown[] } | undefined)?.categories as unknown[]) ??
    ((p.data as { category_list?: unknown[] } | undefined)?.category_list as unknown[]) ??
    [];
  const out: YzCategory[] = [];
  const walk = (arr: unknown[], pid: number | null) => {
    for (const it of arr) {
      const o = it as Record<string, unknown>;
      const id = Number(o.category_id ?? o.id ?? o.cid);
      const name = String(o.name ?? o.category_name ?? "").trim();
      if (!id || !name) continue;
      // 有些接口用 parent_cid/parent_id 字段表明层级
      const nodeParent =
        o.parent_cid != null
          ? Number(o.parent_cid)
          : o.parent_id != null
            ? Number(o.parent_id)
            : pid;
      out.push({
        id,
        name,
        parent_id: nodeParent && nodeParent !== 0 ? nodeParent : null,
        sort_order: Number(o.sort_order ?? 0),
      });
      const children = (o.children as unknown[]) ?? (o.sub_categories as unknown[]);
      if (Array.isArray(children) && children.length > 0) walk(children, id);
    }
  };
  walk(raw as unknown[], defaultParent);
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
    const { rows: yz, api, shop_id, notes } = await fetchYouzanHqCategories();
    const { data: existing, error } = await context.supabase
      .from("inv_categories" as never)
      .select(SELECT_COLS);
    if (error) throw new Error(error.message);
    const local = (existing ?? []) as unknown as CategoryRow[];
    const byYz = new Map(
      local.filter((r) => r.youzan_hq_category_id).map((r) => [r.youzan_hq_category_id!, r]),
    );
    const yzById = new Map(yz.map((y) => [y.id, y]));

    const toAdd: {
      yz: YzCategory;
      suggest_code: string;
      parent_name: string | null;
    }[] = [];
    const toUpdate: { local: CategoryRow; yz: YzCategory }[] = [];
    for (const y of yz) {
      const cur = byYz.get(y.id);
      if (!cur) {
        toAdd.push({
          yz: y,
          suggest_code: pinyinCode(y.name, y.id),
          parent_name: y.parent_id ? (yzById.get(y.parent_id)?.name ?? null) : null,
        });
      } else if (cur.name !== y.name) {
        toUpdate.push({ local: cur, yz: y });
      }
    }
    // 已经映射但有赞已删除的
    const yzIds = new Set(yz.map((y) => y.id));
    const toDeactivate = local.filter(
      (r) => r.youzan_hq_category_id != null && !yzIds.has(r.youzan_hq_category_id) && r.is_active,
    );
    // 按父→子稳定排序，UI 显示更直观
    toAdd.sort((a, b) => {
      const ap = a.yz.parent_id ?? 0;
      const bp = b.yz.parent_id ?? 0;
      if (ap !== bp) return ap - bp;
      return a.yz.name.localeCompare(b.yz.name);
    });
    return {
      api,
      shop_id,
      notes,
      to_add: toAdd,
      to_update: toUpdate,
      to_deactivate: toDeactivate,
    };
  });

const ApplyInput = z.object({
  shop_id: z.string().uuid(),
  add: z
    .array(
      z.object({
        youzan_hq_category_id: z.number().int(),
        youzan_hq_parent_id: z.number().int().nullable().optional(),
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

    // 先按父→子排序（父在前）
    const addSorted = [...data.add].sort((a, b) => {
      const ap = a.youzan_hq_parent_id ?? 0;
      const bp = b.youzan_hq_parent_id ?? 0;
      // parent (=0) 先，子后
      return ap - bp;
    });

    // 用本次已建 + 现有映射查父 local id
    const yzToLocal = new Map<number, string>();
    {
      const { data: existing } = await supabase
        .from("inv_categories" as never)
        .select("id, youzan_hq_category_id");
      for (const r of (existing ?? []) as { id: string; youzan_hq_category_id: number | null }[]) {
        if (r.youzan_hq_category_id) yzToLocal.set(r.youzan_hq_category_id, r.id);
      }
    }

    // ---- add
    for (const a of addSorted) {
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
      const parentLocalId = a.youzan_hq_parent_id
        ? (yzToLocal.get(a.youzan_hq_parent_id) ?? null)
        : null;
      const { data: ins, error } = await supabase
        .from("inv_categories" as never)
        .insert({
          code,
          name: a.name,
          parent_id: parentLocalId,
          youzan_hq_category_id: a.youzan_hq_category_id,
          youzan_hq_parent_id: a.youzan_hq_parent_id ?? null,
          youzan_shop_id: data.shop_id,
          synced_at: now,
          sort_order: parentLocalId ? 600 : 500,
        } as never)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      yzToLocal.set(a.youzan_hq_category_id, (ins as { id: string }).id);
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

