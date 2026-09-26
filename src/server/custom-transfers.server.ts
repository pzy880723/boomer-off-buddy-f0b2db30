import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadUserRoles } from "@/server/handheld-auth.server";
import type {
  CustomTransferInput,
  CustomTransfer,
  TransferResult,
} from "@/lib/custom-transfer-contract";

const db = supabaseAdmin as any;
const messages: Record<string, string> = {
  source_sync_busy: "商品正在同步源门店，请稍后重试发起调拨",
  transfer_create_forbidden: "只有管理员和总部人员可以发起调拨",
  transfer_receive_forbidden: "只能签收授权目标库位的调拨单",
  transfer_not_found: "调拨单不存在或无权访问",
  same_location: "调出和调入库位不能相同",
  invalid_location: "库位不存在或已停用",
  invalid_lines: "请选择有效商品及数量",
  invalid_operation: "调拨请求标识无效",
  idempotency_conflict: "重试内容已改变，请先查询原调拨单",
  stock_unavailable: "商品库存已变化，请刷新后重新选择",
  stock_reserved: "商品已被订单占用，暂不能调拨",
  custom_only: "仅支持在库的自定义商品",
  whole_custom_item_required: "自定义商品必须整件调拨，不能同时留在多个库位",
  already_in_transit: "商品已在其他调拨单中",
  rfid_transfer_required: "该商品已绑定 RFID，请使用原 RFID 流程",
  receipt_required: "请上传 1 至 6 张签收照片",
  receipt_missing: "签收照片尚未上传成功或不属于当前账号和单据",
  source_sync_pending: "源店有赞库存尚未确认清零，照片已保留，请稍后重试签收",
  unexpected_stock: "商品库存发生变化，请联系总部核对后签收",
  transfer_not_in_transit: "当前调拨单不是待签收状态",
};
export class CustomTransferError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(messages[code] ?? code);
  }
}
function check(error: any) {
  if (!error) return;
  const code = error.message;
  if (messages[code])
    throw new CustomTransferError(
      code,
      code.includes("forbidden") ? 403 : code === "transfer_not_found" ? 404 : 409,
    );
  console.error("[custom-transfer]", error.code, error.message);
  throw new CustomTransferError("调拨服务暂时不可用，请保留当前页面稍后重试", 503);
}
async function context(user: string) {
  const roles = await loadUserRoles(user);
  const hq = roles.some((r) => ["super_admin", "hq_operator"].includes(r));
  const perms = await db.from("user_location_perms").select("location_id").eq("user_id", user);
  check(perms.error);
  const allowed = new Set<string>((perms.data ?? []).map((p: any) => p.location_id));
  const locations = await db
    .from("inv_locations")
    .select("id,name,kind,is_active")
    .eq("is_active", true)
    .order("name");
  check(locations.error);
  return {
    hq,
    allowed,
    locations: (locations.data ?? []).filter((l: any) => hq || allowed.has(l.id)),
    canAccess: (id: string) => hq || allowed.has(id),
  };
}
const selection =
  "id,code,status,qty,from_location_id,to_location_id,notes,created_at,received_at,from:inv_locations!from_location_id(name),to:inv_locations!to_location_id(name),lines:stock_transfer_lines(sku_id,expected_qty,source_sync_id,source_sync:youzan_stock_sync_queue!source_sync_id(status,target_stock),sku:inv_skus(name,sku_code,barcode,price_tier))";
function mapTransfer(row: any, canAccess: (id: string) => boolean): CustomTransfer {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    qty: row.qty,
    from_location_id: row.from_location_id,
    to_location_id: row.to_location_id,
    from_name: row.from?.name ?? "原库位",
    to_name: row.to?.name ?? "目标库位",
    notes: row.notes ?? "",
    created_at: row.created_at,
    received_at: row.received_at,
    can_receive: row.status === "in_transit" && canAccess(row.to_location_id),
    photos: [],
    source_sync_pending: (row.lines ?? []).some(
      (l: any) =>
        l.source_sync_id && (l.source_sync?.status !== "done" || l.source_sync?.target_stock !== 0),
    ),
    lines: (row.lines ?? []).map((l: any) => ({
      sku_id: l.sku_id,
      name: l.sku?.name ?? "商品",
      sku_code: l.sku?.sku_code ?? "",
      barcode: l.sku?.barcode ?? "",
      price: Number(l.sku?.price_tier ?? 0),
      qty: l.expected_qty,
      available_qty: 0,
      image_url: "",
    })),
  };
}
async function detail(user: string, id: string, ctx: Awaited<ReturnType<typeof context>>) {
  const r = await db
    .from("stock_transfers")
    .select(selection)
    .eq("id", id)
    .eq("kind", "custom")
    .maybeSingle();
  check(r.error);
  if (!r.data || (!ctx.canAccess(r.data.from_location_id) && !ctx.canAccess(r.data.to_location_id)))
    throw new CustomTransferError("transfer_not_found", 404);
  const transfer = mapTransfer(r.data, ctx.canAccess);
  const photos = await db
    .from("stock_transfer_receipts")
    .select("id,storage_path,used_at,uploaded_by")
    .eq("transfer_id", id);
  check(photos.error);
  for (const p of photos.data ?? []) {
    if (!p.used_at && p.uploaded_by !== user) continue;
    const signed = await db.storage.from("transfer-receipts").createSignedUrl(p.storage_path, 3600);
    check(signed.error);
    transfer.photos.push({ id: p.id, url: signed.data.signedUrl, used: !!p.used_at });
  }
  return transfer;
}
export async function executeCustomTransfer(
  user: string,
  input: CustomTransferInput,
): Promise<TransferResult> {
  const ctx = await context(user);
  if (input.action === "list") {
    if (input.location_id && !ctx.canAccess(input.location_id))
      throw new CustomTransferError("transfer_not_found", 404);
    let q = db
      .from("stock_transfers")
      .select(selection)
      .eq("kind", "custom")
      .order("created_at", { ascending: false });
    const ids = input.location_id ? [input.location_id] : ctx.hq ? null : [...ctx.allowed];
    if (ids?.length === 0)
      return {
        actor_id: user,
        items: [],
        locations: ctx.locations,
        can_create: ctx.hq,
        has_more: false,
      };
    if (ids)
      q = q.or(`from_location_id.in.(${ids.join(",")}),to_location_id.in.(${ids.join(",")})`);
    if (input.status !== "all") q = q.eq("status", input.status);
    if (input.q) q = q.ilike("code", `%${input.q.replace(/[%_]/g, "")}%`);
    const r = await q.range((input.page - 1) * 50, input.page * 50);
    check(r.error);
    return {
      actor_id: user,
      items: (r.data ?? []).slice(0, 50).map((x: any) => mapTransfer(x, ctx.canAccess)),
      locations: ctx.locations,
      can_create: ctx.hq,
      has_more: (r.data ?? []).length > 50,
    };
  }
  if (input.action === "products") {
    if (!ctx.hq) throw new CustomTransferError("transfer_create_forbidden", 403);
    if (!ctx.locations.some((l: any) => l.id === input.location_id))
      throw new CustomTransferError("invalid_location", 400);
    const r = await db.rpc("custom_transfer_products", {
      p_user: user,
      p_location: input.location_id,
      p_query: input.q,
    });
    check(r.error);
    return { products: r.data ?? [] };
  }
  if (input.action === "create") {
    if (!ctx.hq) throw new CustomTransferError("transfer_create_forbidden", 403);
    const r = await db.rpc("custom_transfer_create", {
      p_user: user,
      p_operation: input.client_op_id,
      p_from: input.from_location_id,
      p_to: input.to_location_id,
      p_note: input.notes,
      p_lines: input.lines,
    });
    check(r.error);
    return r.data;
  }
  if (input.action === "detail") return { transfer: await detail(user, input.id, ctx) };
  const transfer = await detail(user, input.id, ctx);
  if (!ctx.canAccess(transfer.to_location_id))
    throw new CustomTransferError("transfer_receive_forbidden", 403);
  if (input.action === "upload") {
    if (transfer.status !== "in_transit") throw new CustomTransferError("transfer_not_in_transit");
    const bytes = Buffer.from(input.image_base64, "base64");
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (bytes.length > 5_242_880 || bytes.length < 32 || (!jpeg && !png))
      throw new CustomTransferError("请上传 5MB 以内的 JPEG 或 PNG 图片", 400);
    const id = randomUUID(),
      path = `${input.id}/${user}/${id}.${jpeg ? "jpg" : "png"}`;
    const uploaded = await db.storage
      .from("transfer-receipts")
      .upload(path, bytes, { contentType: jpeg ? "image/jpeg" : "image/png", upsert: false });
    check(uploaded.error);
    const saved = await db
      .from("stock_transfer_receipts")
      .insert({ id, transfer_id: input.id, uploaded_by: user, storage_path: path });
    if (saved.error) {
      await db.storage.from("transfer-receipts").remove([path]);
      check(saved.error);
    }
    const signed = await db.storage.from("transfer-receipts").createSignedUrl(path, 3600);
    check(signed.error);
    return { photo: { id, url: signed.data.signedUrl } };
  }
  const r = await db.rpc("custom_transfer_receive", {
    p_user: user,
    p_transfer: input.id,
    p_photos: input.photo_ids,
  });
  check(r.error);
  return r.data;
}
