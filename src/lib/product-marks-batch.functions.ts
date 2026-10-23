// ERP 网页批量修改特色印章 / 提示标签 / 翻筐乐。身份来自会话，角色与门店授权服务端校验；逐件 CAS。
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { FEATURED_STAMPS, NOTICE_TAGS } from "@/lib/commerce/product-marks";
import { batchPatchReturned } from "@/lib/commerce/batch-confirmation";

const OpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notice"), add: z.array(z.enum(NOTICE_TAGS)).max(10), remove: z.array(z.enum(NOTICE_TAGS)).max(10) }),
  z.object({ kind: z.literal("stamp"), value: z.enum(FEATURED_STAMPS).nullable() }),
  z.object({ kind: z.literal("fankuang"), value: z.boolean().nullable() }),
]);

export const batchUpdateProductMarks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      op: OpSchema,
      location_id: z.string().uuid(),
      items: z.array(z.object({ id: z.string().uuid(), expected_updated_at: z.string().min(10) })).min(1).max(200),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { runBatchMarks } = await import("@/server/product-marks-batch.server");
    const [{ data: roles, error: roleErr }, { data: perms, error: permErr }] = await Promise.all([
      context.supabase.from("user_roles").select("role").eq("user_id", context.userId),
      context.supabase.from("user_location_perms").select("location_id").eq("user_id", context.userId),
    ]);
    if (roleErr || permErr) throw new Error("无法确认当前账号权限");
    const roleSet = new Set((roles ?? []).map((r) => String(r.role)));
    const actor = {
      hq: roleSet.has("super_admin") || roleSet.has("hq_operator"),
      managerLocationIds: roleSet.has("store_manager") ? (perms ?? []).map((p) => String(p.location_id)) : [],
    };
    if (!actor.hq && !actor.managerLocationIds.includes(data.location_id))
      throw new Response("无权修改该门店商品", { status: 403 });
    const sb = context.supabase;
    const { data: location, error: locationError } = await sb.from("inv_locations")
      .select("id,is_active").eq("id", data.location_id).maybeSingle();
    if (locationError || !location?.is_active) throw new Response("库位不可用", { status: 403 });
    const results = await runBatchMarks({
      async loadSkus(ids) {
        const { data: rows, error } = await sb.from("inv_skus")
          .select("id, status, is_display, is_custom_price, kind, inventory_policy, stock_qty, price_tier, featured_stamp, notice_tags, fankuang_override, updated_at")
          .in("id", ids);
        if (error) throw new Error("商品读取失败");
        const { data: stocks, error: stocksError } = await sb.from("inv_stocks").select("sku_id,qty")
          .in("sku_id", ids).eq("location_id", data.location_id);
        if (stocksError) throw new Response("门店库存读取失败", { status: 403 });
        const quantities = new Map((stocks ?? []).map((s) => [s.sku_id, Number(s.qty)]));
        // No global stock fallback: unallocated legacy HQ cache cannot belong to an arbitrary store.
        return (rows ?? []).map((row) => ({ ...row, current_location_qty: quantities.get(row.id) ?? 0 })) as never;
      },
      async skusAtLocations(ids, locationIds) {
        const { data: rows, error } = await sb.from("inv_stocks").select("sku_id")
          .in("sku_id", ids).in("location_id", locationIds);
        if (error) throw new Error("门店库存读取失败");
        return new Set((rows ?? []).map((r) => String(r.sku_id)));
      },
      async casUpdate(id, expected, patch) {
        // Recheck the actor and selected location before EACH write; a revocation stops the batch.
        const [{ data: liveRoles, error: liveRoleErr }, { data: livePerms, error: livePermErr }] = await Promise.all([
          sb.from("user_roles").select("role").eq("user_id", context.userId),
          sb.from("user_location_perms").select("location_id").eq("user_id", context.userId),
        ]);
        if (liveRoleErr || livePermErr) throw new Response("权限读取失败", { status: 403 });
        const rolesNow = new Set((liveRoles ?? []).map((r) => String(r.role)));
        const hqNow = rolesNow.has("super_admin") || rolesNow.has("hq_operator");
        if (!hqNow && !(rolesNow.has("store_manager") && (livePerms ?? []).some((p) => p.location_id === data.location_id)))
          throw new Response("权限已变化", { status: 403 });
        const { data: stock, error: stockErr } = await sb.from("inv_stocks").select("sku_id,qty")
          .eq("sku_id", id).eq("location_id", data.location_id).maybeSingle();
        if (stockErr || !stock) throw new Response("商品已不属于当前库位", { status: 403 });
        if (patch.fankuang_override === true && !(Number(stock.qty) > 0)) return null;
        let update = sb.from("inv_skus")
          .update({ ...patch, updated_at: new Date().toISOString() } as never)
          .eq("id", id).eq("updated_at", expected).eq("status", "active");
        if (patch.fankuang_override === true) update = update.or("is_display.eq.true,is_display.is.null");
        const { data: row, error } = await update.select("updated_at,featured_stamp,notice_tags,fankuang_override").maybeSingle();
        if (error?.code === "42501") throw new Response("无权保存", { status: 403 });
        if (error) throw new Error("write_failed");
        if (row && !batchPatchReturned(patch, row))
          throw new Error("write_failed");
        return row ? String((row as { updated_at: string }).updated_at) : null;
      },
    }, actor, data);
    return { results };
  });

/** Read-only scope options; server role checks remain authoritative for every submission. */
export const getBatchMarkScope = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = context.supabase;
    const [rolesRes, permsRes, locRes] = await Promise.all([
      sb.from("user_roles").select("role").eq("user_id", context.userId),
      sb.from("user_location_perms").select("location_id").eq("user_id", context.userId),
      sb.from("inv_locations").select("id,name,kind").eq("is_active", true),
    ]);
    if (rolesRes.error || permsRes.error || locRes.error) throw new Response("权限读取失败", { status: 403 });
    const roles = (rolesRes.data ?? []).map((r) => String(r.role)).sort();
    const hq = roles.includes("super_admin") || roles.includes("hq_operator");
    const ids = new Set((permsRes.data ?? []).map((p) => p.location_id));
    const locations = (hq || roles.includes("store_manager")) ? (locRes.data ?? []).filter((l) => hq || ids.has(l.id)) : [];
    return { userId: context.userId, roles, locations };
  });

export const listBatchLocationStocks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ location_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const [rolesRes, permsRes] = await Promise.all([
      sb.from("user_roles").select("role").eq("user_id", context.userId),
      sb.from("user_location_perms").select("location_id").eq("user_id", context.userId),
    ]);
    if (rolesRes.error || permsRes.error) throw new Response("权限读取失败", { status: 403 });
    const roles = (rolesRes.data ?? []).map((r) => String(r.role));
    if (!roles.some((r) => r === "super_admin" || r === "hq_operator") &&
      !(roles.includes("store_manager") && (permsRes.data ?? []).some((p) => p.location_id === data.location_id)))
      throw new Response("库位未授权", { status: 403 });
    const rows: Array<{ sku_id: string; qty: number }> = [];
    // PostgREST caps each page; do not silently hide later stock records.
    for (let start = 0; ; start += 1000) {
      const { data: page, error } = await sb.from("inv_stocks").select("sku_id,qty")
        .eq("location_id", data.location_id).order("sku_id").range(start, start + 999);
      if (error) throw new Response("库存读取失败", { status: 403 });
      rows.push(...(page ?? []));
      if ((page ?? []).length < 1000) break;
    }
    return rows;
  });
