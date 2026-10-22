// ERP 网页批量修改特色印章 / 提示标签 / 翻筐乐。身份来自会话，角色与门店授权服务端校验；逐件 CAS。
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { FEATURED_STAMPS, NOTICE_TAGS } from "@/lib/commerce/product-marks";

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
      location_id: z.string().uuid().nullable().default(null),
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const results = await runBatchMarks({
      async loadSkus(ids) {
        const { data: rows, error } = await supabaseAdmin.from("inv_skus")
          .select("id, status, is_custom_price, kind, inventory_policy, stock_qty, price_tier, featured_stamp, notice_tags, fankuang_override, updated_at")
          .in("id", ids);
        if (error) throw new Error("商品读取失败");
        return (rows ?? []) as never;
      },
      async skusAtLocations(ids, locationIds) {
        const { data: rows, error } = await supabaseAdmin.from("inv_stocks").select("sku_id")
          .in("sku_id", ids).in("location_id", locationIds);
        if (error) throw new Error("门店库存读取失败");
        return new Set((rows ?? []).map((r) => String(r.sku_id)));
      },
      async casUpdate(id, expected, patch) {
        const { data: row, error } = await supabaseAdmin.from("inv_skus")
          .update({ ...patch, updated_at: new Date().toISOString() } as never)
          .eq("id", id).eq("updated_at", expected).eq("status", "active")
          .select("updated_at").maybeSingle();
        if (error) throw new Error("write_failed");
        return row ? String((row as { updated_at: string }).updated_at) : null;
      },
    }, actor, data);
    return { results };
  });
