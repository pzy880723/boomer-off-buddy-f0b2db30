import { createHash } from "node:crypto";
import { normalizeNoticeTags, type NoticeTag } from "@/lib/commerce/product-marks";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { findSanrioBrandCandidate } from "@/lib/product-classification";
import { matchBrandCandidate, normalizeLookupText } from "@/lib/product-taxonomy";
import { loadActiveProductBrands, loadActiveProductIps } from "./product-classification.server";

export function getSmartCreateReleaseTarget(input: {
  autoPushYouzan: boolean;
  locationKind: string;
  shopId: string | null | undefined;
}): string | null {
  if (!input.autoPushYouzan) return null;
  if (input.locationKind !== "shop") return null;
  return input.shopId?.trim() || null;
}

export function shouldReuseSmartCreateSku(isCustomPrice: boolean): boolean {
  return !isCustomPrice;
}

export async function resolveConfirmedListingBrand(input: {
  brand?: string | null; brand_id?: string; brand_confirmed?: boolean;
}): Promise<{ id: string; name: string; review: boolean } | null> {
  if (!input.brand_id && !input.brand_confirmed) return null;
  const name = input.brand?.trim() || "";
  if (!name) {
    if (input.brand_id) throw new Error("请选择品牌名称");
    return null;
  }
  if (input.brand_id) {
    const { data, error } = await supabaseAdmin.from("inv_brands").select("id,name,name_original,aliases,status,entity_type")
      .eq("id", input.brand_id).maybeSingle();
    if (error) throw new Error("品牌库暂不可用，请重试");
    if (!data || data.status !== "active") throw new Error("该品牌不可选，请重新确认");
    const isLegacySanrioParent = data.entity_type === "ip" && findSanrioBrandCandidate([], [data])?.id === data.id;
    if (data.entity_type !== "brand" && !isLegacySanrioParent) throw new Error("该记录不是品牌，请重新确认");
    if (matchBrandCandidate(name, [data]).match?.id !== data.id) throw new Error("品牌名称与选中的品牌不一致，请重新选择");
    return { id: data.id, name: data.name, review: false };
  }
  const [brands, ips] = await Promise.all([loadActiveProductBrands(), loadActiveProductIps()]);
  const sanrio = findSanrioBrandCandidate(brands, ips);
  const match = matchBrandCandidate(name, [...brands, ...(sanrio ? [sanrio] : [])]);
  if (match.match) return { id: match.match.id, name: match.match.name, review: false };
  const normalized = normalizeLookupText(name);
  const read = async () => supabaseAdmin.from("inv_brands").select("id,name,status,entity_type")
    .eq("normalized_name", normalized).maybeSingle();
  const existing = await read();
  if (existing.error) throw new Error("品牌库暂不可用，请重试");
  if (existing.data) {
    if (existing.data.entity_type !== "brand" || existing.data.status === "inactive") throw new Error("同名记录不是可用品牌，请联系总部核对");
    return { id: existing.data.id, name: existing.data.name, review: existing.data.status !== "active" };
  }
  const created = await supabaseAdmin.from("inv_brands").insert({ name, normalized_name: normalized,
    aliases: [], entity_type: "brand", status: "review", notes: "手持端店员确认申请，待总部审核" }).select("id,name").single();
  if (created.error?.code === "23505") {
    const winner = await read();
    if (winner.data?.entity_type === "brand" && winner.data.status !== "inactive") {
      return { id: winner.data.id, name: winner.data.name, review: winner.data.status !== "active" };
    }
  }
  if (created.error || !created.data) throw new Error("品牌申请保存失败，请重试");
  return { ...created.data, review: true };
}

export async function persistSmartCreateBrand(input: {
  skuId: string;
  brand?: string | null;
  confirmedBrand?: { id: string; name: string; review: boolean } | null;
}): Promise<void> {
  if (input.brand === undefined) return;
  const brandText = input.confirmedBrand?.name || input.brand?.trim() || null;
  const [brands, ips] = brandText
    ? await Promise.all([loadActiveProductBrands(), loadActiveProductIps()])
    : [[], []];
  const sanrio = findSanrioBrandCandidate(brands, ips);
  const brand = matchBrandCandidate(brandText, [...brands, ...(sanrio ? [sanrio] : [])]);

  // Read after audit attachment so changing the brand retains all other AI attributes.
  const current = await supabaseAdmin
    .from("inv_skus")
    .select("attributes")
    .eq("id", input.skuId)
    .maybeSingle();
  if (current.error || !current.data) {
    throw new Error(`读取 SKU 品牌属性失败：${current.error?.message ?? "not found"}`);
  }
  const attributes = current.data.attributes;
  const saved = await supabaseAdmin
    .from("inv_skus")
    .update({
      attributes: {
        ...(attributes && typeof attributes === "object" && !Array.isArray(attributes)
          ? attributes
          : {}),
        brand: brandText,
      },
      brand_id: input.confirmedBrand?.id ?? brand.match?.id ?? null,
      brand_candidate_text: input.confirmedBrand ? (input.confirmedBrand.review ? brandText : null)
        : brand.status === "review_required" ? brand.candidate_text : null,
      updated_at: new Date().toISOString(),
    } as never)
    .eq("id", input.skuId);
  if (saved.error) throw new Error(`保存 SKU 品牌失败：${saved.error.message}`);
}

export type SmartCreateCommitResult = {
  op_id: string | null;
  replayed: boolean;
  op_status: "committed" | "completed" | "cancelled";
  marks_applied?: boolean;
  sku_id: string;
  sku_code: string | null;
  epc: string;
  bound_epcs: number;
  stock_qty: number | null;
  response: unknown;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** 载荷指纹：排除 client_op_id 与 ai_processing_allowed（AI 开关不改变商品业务身份），键排序，含目标库位；签名 URL 需先规范化再传入。 */
export function smartCreateFingerprint(body: Record<string, unknown>, locationId: string): string {
  const { client_op_id: _ignored, ai_processing_allowed: _aiFlag, ...rest } = body;
  // Omitted marks stay absent (legacy fingerprints unchanged); present tags are order-normalized.
  if (Array.isArray(rest.notice_tags)) rest.notice_tags = normalizeNoticeTags(rest.notice_tags as NoticeTag[]);
  return createHash("sha256")
    .update(JSON.stringify(canonical({ ...rest, location_id: locationId })))
    .digest("hex");
}


// Shared by smart-create and smart-create/cancel so both compute the identical fingerprint.
const SKU_IMAGE_BUCKETS = new Set(["sku-raw", "sku-listing"]);

export function normalizeBucketPath(
  bucket: "sku-raw" | "sku-listing",
  storagePath: string,
): string | null {
  const clean = storagePath.trim().replace(/^\/+/, "");
  if (!clean) return null;
  if (clean.startsWith(`${bucket}/`)) return clean;
  return `${bucket}/${clean}`;
}

function parseStorageObjectUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const markers = [
      "/storage/v1/object/sign/",
      "/storage/v1/object/public/",
      "/storage/v1/object/authenticated/",
      "/storage/v1/object/upload/sign/",
    ];
    for (const marker of markers) {
      const idx = url.pathname.indexOf(marker);
      if (idx < 0) continue;
      const rest = url.pathname.slice(idx + marker.length).replace(/^\/+/, "");
      const parts = rest.split("/").map((part) => decodeURIComponent(part));
      const bucket = parts.shift();
      const path = parts.join("/");
      if (bucket && SKU_IMAGE_BUCKETS.has(bucket) && path) return `${bucket}/${path}`;
    }
  } catch {
    return null;
  }
  return null;
}

export function normalizeIncomingImageUrl(imageUrl?: string | null): string | null {
  const raw = imageUrl?.trim();
  if (!raw) return null;
  const storagePath = parseStorageObjectUrl(raw);
  if (storagePath) return storagePath;
  // 只有稳定外链才直接存 image_url；signed URL 会过期，不能落库。
  if (/^https?:\/\//i.test(raw) && !raw.includes("token=")) return raw;
  return null;
}


export function smartCreateRequestFingerprint(
  body: Record<string, unknown> & { image_url?: string | null }, locationId: string,
): { fingerprint: string; incomingPaths: string[]; normalizedImageUrl: string | null } {
  const incomingPaths: string[] = [];
  for (const p of (body.image_storage_paths as Array<{ bucket: "sku-raw" | "sku-listing"; storage_path: string }> | undefined) ?? []) {
    const normalized = normalizeBucketPath(p.bucket, p.storage_path);
    if (normalized) incomingPaths.push(normalized);
  }
  const normalizedImageUrl = normalizeIncomingImageUrl(body.image_url);
  if (normalizedImageUrl) incomingPaths.push(normalizedImageUrl);
  return { fingerprint: smartCreateFingerprint({ ...body, image_url: normalizedImageUrl }, locationId), incomingPaths, normalizedImageUrl };
}
