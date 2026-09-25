/**
 * 手持端商品修改 / 删除：路由薄层 → 数据库事务 RPC（handheld_item_update / handheld_item_delete）。
 * 员工身份由设备 + 会话解析后显式传给 RPC；RPC 仅 service_role 可执行，并按 p_user_id 校验角色，
 * 因此服务角色不能冒充员工绕过总部/门店检查。
 */
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { err, ok, resolveSessionUser } from "@/server/handheld-auth.server";
import { ItemDeleteReq, ItemPatchReq } from "@/lib/handheld/item-edit-schemas";

const ERROR_STATUS: Record<string, number> = {
  session_required: 401,
  location_forbidden: 403,
  edit_forbidden: 403,
  delete_forbidden: 403,
  standard_readonly: 403,
  not_found: 404,
  sku_archived: 409,
  version_conflict: 409,
  client_op_id_conflict: 409,
  delete_blocked: 409,
  validation_error: 422,
  invalid_client_op_id: 422,
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function itemOpFingerprint(op: "update" | "delete", skuId: string, body: unknown) {
  return createHash("sha256").update(canonical({ op, skuId, body })).digest("hex");
}

export function mapRpcError(error: { message?: string; details?: string | null } | null) {
  const code = error?.message ?? "";
  const status = ERROR_STATUS[code];
  if (!status) return err("商品操作失败，请稍后重试", 500, { code: "internal_error" });
  const detail = error?.details || undefined;
  if (code === "version_conflict")
    return err("商品已被他人修改，请刷新后重试", 409, { code, current_updated_at: detail ?? null });
  return err(detail || code, status, { code, ...(code === "delete_blocked" ? { reason: detail } : {}) });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleItemPatch(request: Request, deviceId: string, skuId: string) {
  const session = await resolveSessionUser(request);
  if (!session) return err("Employee session required", 401, { code: "unauthorized" });
  const parsed = ItemPatchReq.safeParse(await readJson(request));
  if (!parsed.success)
    return err("Validation failed", 422, { code: "validation_error", issues: parsed.error.issues });
  const b = parsed.data;
  const patch: Record<string, unknown> = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.price_tier !== undefined) patch.price_tier = Math.round(b.price_tier * 100) / 100;
  if (b.description !== undefined) patch.notes = b.description;
  if (b.condition_grade !== undefined) patch.grade = b.condition_grade;
  if (b.image_paths !== undefined) patch.image_paths = b.image_paths;
  const { data, error } = await supabaseAdmin.rpc("handheld_item_update" as never, {
    p_device_id: deviceId,
    p_user_id: session.user_id,
    p_client_op_id: b.client_op_id,
    p_location_id: b.location_id.toLowerCase(),
    p_sku_id: skuId,
    p_expected_updated_at: b.expected_updated_at,
    p_patch: patch,
    p_fingerprint: itemOpFingerprint("update", skuId, {
      location_id: b.location_id.toLowerCase(),
      expected_updated_at: new Date(b.expected_updated_at).toISOString(),
      patch,
    }),
  } as never);
  if (error) return mapRpcError(error as never);
  const r = data as Record<string, unknown>;
  return ok({
    sku_id: r.sku_id,
    updated_at: r.updated_at,
    changed_fields: r.changed_fields ?? [],
    replayed: r.replayed === true,
    youzan_sync_queued: Number(r.youzan_sync_queued ?? 0),
  });
}

export async function handleItemDelete(request: Request, deviceId: string, skuId: string) {
  const session = await resolveSessionUser(request);
  if (!session) return err("Employee session required", 401, { code: "unauthorized" });
  const parsed = ItemDeleteReq.safeParse(await readJson(request));
  if (!parsed.success)
    return err("删除需要 confirm:true、location_id 与 client_op_id", 422, {
      code: "validation_error",
      issues: parsed.error.issues,
    });
  const b = parsed.data;
  const { data, error } = await supabaseAdmin.rpc("handheld_item_delete" as never, {
    p_device_id: deviceId,
    p_user_id: session.user_id,
    p_client_op_id: b.client_op_id,
    p_location_id: b.location_id.toLowerCase(),
    p_sku_id: skuId,
    p_fingerprint: itemOpFingerprint("delete", skuId, { location_id: b.location_id.toLowerCase() }),
  } as never);
  if (error) return mapRpcError(error as never);
  const r = data as Record<string, unknown>;
  return ok({ deleted_sku_id: r.deleted_sku_id, replayed: r.replayed === true });
}

/** GET 详情附带的能力位：can_delete 仅代表权限，不保证无业务引用。 */
export async function loadItemCapabilities(args: {
  userId: string;
  locationId: string | null;
  skuId: string;
  productType: string;
  status: string;
}) {
  const { data: roles, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", args.userId);
  if (error) throw error;
  const set = new Set((roles ?? []).map((r) => String(r.role)));
  const hq = set.has("super_admin") || set.has("hq_operator");
  const active = args.status === "active";
  let manager = false;
  if (!hq && set.has("store_manager") && args.locationId) {
    const [{ data: perm }, { data: stock }] = await Promise.all([
      supabaseAdmin
        .from("user_location_perms")
        .select("location_id")
        .eq("user_id", args.userId)
        .eq("location_id", args.locationId)
        .maybeSingle(),
      supabaseAdmin
        .from("inv_stocks")
        .select("sku_id")
        .eq("sku_id", args.skuId)
        .eq("location_id", args.locationId)
        .maybeSingle(),
    ]);
    manager = !!perm && !!stock;
  }
  return {
    can_edit: active && args.productType !== "standard" && (hq || manager),
    can_delete: active && hq,
  };
}
