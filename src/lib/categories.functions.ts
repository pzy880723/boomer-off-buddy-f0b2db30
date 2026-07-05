import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getYouzanOutboundStatus } from "./youzan-http";

/**
 * 本模块管理「商品分类」——ERP 唯一真源。
 * 有赞分组只在「同步到有赞时选一个默认分组」时用到，不再和 ERP 分类做一对一绑定。
 */

export type CategoryRow = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
};

const SELECT_COLS = "id, code, name, parent_id, sort_order, is_active, is_system";

/* ---------- 列表 ---------- */
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
    if (!cat) throw new Error("分类不存在");
    const row = cat as { code: string; is_system: boolean };
    if (row.is_system) throw new Error("系统种子分类不可删除，可停用");
    const { count } = await supabase
      .from("inv_skus")
      .select("id", { count: "exact", head: true })
      .eq("category", row.code);
    if ((count ?? 0) > 0)
      throw new Error(`该分类下还有 ${count} 个商品，不能删除，请先停用`);
    const { error } = await supabase
      .from("inv_categories" as never)
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ==========================================================================
 * 有赞店铺分组 · 仅用于「设置」页选择同步默认分组
 * ========================================================================== */

export type YouzanGroupNode = {
  id: number;
  name: string;
  parent_id: number | null;
  sort_order: number;
};

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
  const ipMatch = msg.match(
    /(?:gw\s*4007|源\s*IP\s*地址|IP\s+|whitelist)[^0-9]*((?:\d{1,3}\.){3}\d{1,3})/i,
  );
  if (ipMatch) return { kind: "ip_blocked", message: msg, ip: ipMatch[1] };
  if (/gw\s*4005|非法的\s*API|invalid\s*api/i.test(msg))
    return { kind: "no_api", message: msg };
  return { kind: "other", message: msg };
}

function normalizeGroups(payload: unknown): YouzanGroupNode[] {
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
  const out: YouzanGroupNode[] = [];
  const walk = (arr: unknown[], pid: number | null) => {
    for (const it of arr) {
      const o = it as Record<string, unknown>;
      const id = Number(o.category_id ?? o.id ?? o.cid ?? o.group_id ?? o.tag_id);
      const name = String(
        o.name ?? o.category_name ?? o.group_name ?? o.tag_name ?? "",
      ).trim();
      if (!id || !name) continue;
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
  walk(raw as unknown[], null);
  return out;
}

export const fetchYouzanGroupsLive = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getHqShop, ensureAccessToken, callYouzanApiVerbose } = await import(
      "@/lib/youzan.functions"
    );
    const hq = await getHqShop();
    const token = await ensureAccessToken(hq);
    const notes: SyncNote[] = [];
    let usedApi = "";
    let rows: YouzanGroupNode[] = [];
    let ipBlock: { ip: string; raw: string; apis: string[] } | null = null;

    const attempts = [{ method: "youzan.itemcategories.tags.get", version: "3.0.0" }];
    for (const a of attempts) {
      try {
        const { payload } = await callYouzanApiVerbose({
          accessToken: token,
          method: a.method,
          version: a.version,
        });
        const r = normalizeGroups(payload);
        if (r.length > 0) {
          usedApi = a.method;
          rows = r;
          notes.push({ api: a.method, status: "ok", message: "拉取成功", count: r.length });
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
    let blocking: BlockingError | null = null;
    if (rows.length === 0) {
      if (ipBlock) {
        blocking = {
          kind: "ip_whitelist",
          ip: ipBlock.ip,
          apis: ipBlock.apis,
          raw: ipBlock.raw,
        };
      } else {
        const noApis = notes.filter((n) => n.status === "no_api").map((n) => n.api);
        blocking =
          noApis.length > 0 && noApis.length === notes.length
            ? { kind: "no_api", apis: noApis }
            : {
                kind: "other",
                message: notes.map((n) => `${n.api}: ${n.message}`).join("\n"),
              };
      }
    }
    return {
      api: usedApi,
      shop_id: hq.id,
      outbound: getYouzanOutboundStatus(),
      notes,
      blocking,
      rows,
    };
  });
