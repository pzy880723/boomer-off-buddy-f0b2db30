import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * 本模块管理「商品分组」——ERP 侧唯一真源，来源是有赞【商品 → 分组管理】里
 * 店铺自建的分组（不是平台标准类目）。字段名沿用 CategoryRow 以减少改动。
 */

export type CategoryRow = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  /** 有赞店铺分组 id（HQ 店铺侧） */
  youzan_hq_category_id: number | null;
  youzan_hq_parent_id: number | null;
  youzan_shop_id: string | null;
  synced_at: string | null;
};

const SELECT_COLS =
  "id, code, name, parent_id, sort_order, is_active, is_system, " +
  "youzan_hq_group_id, youzan_hq_group_parent_id, youzan_shop_id, synced_at";

type RawRow = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
  youzan_hq_group_id: number | null;
  youzan_hq_group_parent_id: number | null;
  youzan_shop_id: string | null;
  synced_at: string | null;
};

const toRow = (r: RawRow): CategoryRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  parent_id: r.parent_id,
  sort_order: r.sort_order,
  is_active: r.is_active,
  is_system: r.is_system,
  youzan_hq_category_id: r.youzan_hq_group_id,
  youzan_hq_parent_id: r.youzan_hq_group_parent_id,
  youzan_shop_id: r.youzan_shop_id,
  synced_at: r.synced_at,
});

/* ---------- 列表（商品分类，已合并原分组）---------- */
export const listCategories = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("inv_categories" as never)
      .select(SELECT_COLS)
      .eq("kind", "category")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { rows: ((data ?? []) as unknown as RawRow[]).map(toRow) };
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
      kind: "category",
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
    if (!cat) throw new Error("分组不存在");
    const row = cat as { code: string; is_system: boolean };
    if (row.is_system) throw new Error("系统种子分组不可删除，可停用");
    const { count } = await supabase
      .from("inv_skus")
      .select("id", { count: "exact", head: true })
      .eq("category", row.code);
    if ((count ?? 0) > 0) throw new Error(`该分组下还有 ${count} 个商品，不能删除，请先停用`);
    const { error } = await supabase
      .from("inv_categories" as never)
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ==========================================================================
 * 有赞店铺分组同步
 * ========================================================================== */

type YzGroup = { id: number; name: string; parent_id: number | null; sort_order?: number };

export type SyncNote = {
  api: string;
  status: "ok" | "no_api" | "ip_blocked" | "empty" | "error";
  message: string;
  count?: number;
};
export type BlockingError =
  | { kind: "ip_whitelist"; ip: string; apis: string[]; raw: string }
  | { kind: "no_api"; apis: string[] }
  | { kind: "other"; message: string };

function classifyYouzanError(err: unknown): {
  kind: "ip_blocked" | "no_api" | "other";
  message: string;
  ip?: string;
} {
  const msg = err instanceof Error ? err.message : String(err);
  const ipMatch = msg.match(/(?:gw\s*4007|源\s*IP\s*地址)[^0-9]*((?:\d{1,3}\.){3}\d{1,3})/i);
  if (ipMatch) return { kind: "ip_blocked", message: msg, ip: ipMatch[1] };
  if (/gw\s*4005|非法的\s*API|invalid\s*api/i.test(msg)) return { kind: "no_api", message: msg };
  return { kind: "other", message: msg };
}

async function fetchYouzanHqGroups(): Promise<{
  api: string;
  shop_id: string;
  rows: YzGroup[];
  notes: SyncNote[];
  blocking?: BlockingError;
}> {
  const { getHqShop, ensureAccessToken, callYouzanApiVerbose } = await import(
    "@/lib/youzan.functions"
  );
  const hq = await getHqShop();
  const token = await ensureAccessToken(hq);
  const notes: SyncNote[] = [];

  // 商品分组（自定义 tag 树，一级/二级）——有赞云团队官方答复：
  //   查询分组本身 → youzan.itemcategories.tags.get
  //   字段：id / name / upper_id(0=一级) / type(0=商家自定义分组)
  const attempts: { method: string; version: string }[] = [
    { method: "youzan.itemcategories.tags.get", version: "3.0.0" },
  ];


  let usedApi = "";
  let allRows: YzGroup[] = [];
  let ipBlock: { ip: string; raw: string; apis: string[] } | null = null;

  for (const a of attempts) {
    try {
      const { payload } = await callYouzanApiVerbose({
        accessToken: token,
        method: a.method,
        version: a.version,
      });
      const rows = normalizeGroups(payload);
      if (rows.length > 0) {
        usedApi = a.method;
        allRows = rows;
        notes.push({ api: a.method, status: "ok", message: "拉取成功", count: rows.length });
        break;
      }
      notes.push({ api: a.method, status: "empty", message: "返回空" });
    } catch (e) {
      const c = classifyYouzanError(e);
      if (c.kind === "ip_blocked") {
        notes.push({ api: a.method, status: "ip_blocked", message: c.message });
        ipBlock = ipBlock ?? { ip: c.ip ?? "", raw: c.message, apis: [] };
        ipBlock.apis.push(a.method);
        break;
      }
      notes.push({
        api: a.method,
        status: c.kind === "no_api" ? "no_api" : "error",
        message: c.message,
      });
    }
  }

  if (allRows.length === 0) {
    let blocking: BlockingError;
    if (ipBlock) {
      blocking = { kind: "ip_whitelist", ip: ipBlock.ip, apis: ipBlock.apis, raw: ipBlock.raw };
    } else {
      const noApis = notes.filter((n) => n.status === "no_api").map((n) => n.api);
      blocking =
        noApis.length > 0 && noApis.length === notes.length
          ? { kind: "no_api", apis: noApis }
          : { kind: "other", message: notes.map((n) => `${n.api}: ${n.message}`).join("\n") };
    }
    return { api: "", shop_id: hq.id, rows: [], notes, blocking };
  }

  return { api: usedApi, shop_id: hq.id, rows: allRows, notes };
}

function normalizeGroups(payload: unknown, defaultParent: number | null = null): YzGroup[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, unknown>;
  const dataObj = (p.data ?? {}) as Record<string, unknown>;
  const raw =
    (p.tags as unknown[]) ??
    (dataObj.tags as unknown[]) ??
    (p.categories as unknown[]) ??
    (p.category_list as unknown[]) ??
    (p.shop_categories as unknown[]) ??
    (p.groups as unknown[]) ??
    (p.children as unknown[]) ??
    (dataObj.categories as unknown[]) ??
    (dataObj.category_list as unknown[]) ??
    (dataObj.shop_categories as unknown[]) ??
    [];
  const out: YzGroup[] = [];
  const walk = (arr: unknown[], pid: number | null) => {
    for (const it of arr) {
      const o = it as Record<string, unknown>;
      const id = Number(o.category_id ?? o.id ?? o.cid ?? o.group_id ?? o.tag_id);
      const name = String(o.name ?? o.category_name ?? o.group_name ?? o.tag_name ?? "").trim();
      if (!id || !name) continue;
      // 只保留商家自定义分组 (type=0)；若字段缺失（旧接口）则一律保留
      if (o.type != null && Number(o.type) !== 0) continue;
      const nodeParent =
        o.upper_id != null
          ? Number(o.upper_id)
          : o.parent_cid != null
            ? Number(o.parent_cid)
            : o.parent_id != null
              ? Number(o.parent_id)
              : pid;
      out.push({
        id,
        name,
        parent_id: nodeParent && nodeParent !== 0 ? nodeParent : null,
        sort_order: Number(o.sort_order ?? o.order ?? 0),
      });
      const children = (o.children as unknown[]) ?? (o.sub_categories as unknown[]);
      if (Array.isArray(children) && children.length > 0) walk(children, id);
    }
  };
  walk(raw as unknown[], defaultParent);
  return out;
}


function pinyinCode(name: string, yzId: number): string {
  const ascii = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (ascii.length >= 2) return ascii.slice(0, 8);
  return `YZ${String(yzId).slice(-4)}`;
}

export const previewYouzanCategorySync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { rows: yz, api, shop_id, notes, blocking } = await fetchYouzanHqGroups();
    const { data: existing, error } = await context.supabase
      .from("inv_categories" as never)
      .select(SELECT_COLS)
      .eq("kind", "category");
    if (error) throw new Error(error.message);
    const local = ((existing ?? []) as unknown as RawRow[]).map(toRow);
    const byYz = new Map(
      local.filter((r) => r.youzan_hq_category_id).map((r) => [r.youzan_hq_category_id!, r]),
    );
    const yzById = new Map(yz.map((y) => [y.id, y]));

    const toAdd: {
      yz: YzGroup;
      suggest_code: string;
      parent_name: string | null;
    }[] = [];
    const toUpdate: { local: CategoryRow; yz: YzGroup }[] = [];
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
    const yzIds = new Set(yz.map((y) => y.id));
    const toDeactivate = local.filter(
      (r) => r.youzan_hq_category_id != null && !yzIds.has(r.youzan_hq_category_id) && r.is_active,
    );
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
      blocking: blocking ?? null,
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

    const addSorted = [...data.add].sort((a, b) => {
      const ap = a.youzan_hq_parent_id ?? 0;
      const bp = b.youzan_hq_parent_id ?? 0;
      return ap - bp;
    });

    const yzToLocal = new Map<number, string>();
    {
      const { data: existing } = await supabase
        .from("inv_categories" as never)
        .select("id, youzan_hq_group_id");
      for (const r of (existing ?? []) as { id: string; youzan_hq_group_id: number | null }[]) {
        if (r.youzan_hq_group_id) yzToLocal.set(r.youzan_hq_group_id, r.id);
      }
    }

    for (const a of addSorted) {
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
          kind: "category",
          youzan_hq_group_id: a.youzan_hq_category_id,
          youzan_hq_group_parent_id: a.youzan_hq_parent_id ?? null,
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
    for (const u of data.update) {
      const { error } = await supabase
        .from("inv_categories" as never)
        .update({ name: u.name, synced_at: now } as never)
        .eq("id", u.id);
      if (error) throw new Error(error.message);
      updatedN++;
    }
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

/* ==========================================================================
 * 商品分类 · 与有赞分组的一一对应绑定
 * ========================================================================== */

export type YouzanGroupNode = {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
};

export const fetchYouzanGroupsLive = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { rows, api, shop_id, notes, blocking } = await fetchYouzanHqGroups();
    return {
      api,
      shop_id,
      notes,
      blocking: blocking ?? null,
      rows: rows as YouzanGroupNode[],
    };
  });

const BindInput = z.object({
  erp_id: z.string().uuid(),
  youzan_group_id: z.number().int().nullable(),
  youzan_parent_id: z.number().int().nullable().optional(),
  youzan_shop_id: z.string().uuid().nullable().optional(),
});
export const bindErpToYouzan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => BindInput.parse(i))
  .handler(async ({ data, context }) => {
    // 一一对应：若目标 group_id 已被其他 ERP 分类占用，先解绑对方
    if (data.youzan_group_id != null) {
      await context.supabase
        .from("inv_categories" as never)
        .update({
          youzan_hq_group_id: null,
          youzan_hq_group_parent_id: null,
          youzan_shop_id: null,
        } as never)
        .eq("youzan_hq_group_id", data.youzan_group_id)
        .neq("id", data.erp_id);
    }
    const { error } = await context.supabase
      .from("inv_categories" as never)
      .update({
        youzan_hq_group_id: data.youzan_group_id,
        youzan_hq_group_parent_id: data.youzan_parent_id ?? null,
        youzan_shop_id: data.youzan_shop_id ?? null,
        synced_at: new Date().toISOString(),
      } as never)
      .eq("id", data.erp_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

