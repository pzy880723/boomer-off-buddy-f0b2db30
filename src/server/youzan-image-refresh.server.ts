import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPublicOrigin } from "@/lib/sku-media";
import { imageRefreshSources, YOUZAN_CHANNEL_IMAGE_LIMIT } from "../lib/youzan-image-media";

export type ImageSnapshot = {
  sku_id: string; shop_id: string; kdt_id: number; hq_shop_id: string; hq_spu_id: number;
  branch_item_id: number; barcode: string; image_paths: string[]; image_url?: string | null;
};
type Material = { imageId: number; imageUrl: string };
type Master = { spuId: number; itemId: number; spuCode: string; images: string[] };
type Branch = { itemId: number; barcode: string; images: string[] };
export type ImageRefreshDeps = {
  origin: string;
  readMaster: () => Promise<Master | null>;
  readBranch: (masterCode: string) => Promise<Branch | null>;
  assertExclusiveMaster: (masterCode: string) => Promise<void>;
  upload: (url: string) => Promise<Material>;
  updateMaster: (id: number, materials: Material[]) => Promise<void>;
};

export function readYouzanImageUrls(value: unknown): string[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return /^https?:\/\//.test(value as string) ? [value as string] : []; }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap(v => {
    const url = typeof v === "string" ? v : v?.url ?? v?.image_url ?? v?.img_url;
    return typeof url === "string" && /^https?:\/\//.test(url) ? [url] : [];
  });
}

// Only this image-only adapter owns remote mutations. It has no publish/stock API dependency.
export async function refreshYouzanImages(s: ImageSnapshot, current: () => Promise<boolean>, d: ImageRefreshDeps) {
  const sources = imageRefreshSources(s, d.origin);
  // Existing offline channel supports five. Keep the first/cover; expose any omission in the result.
  const urls = sources.slice(0,YOUZAN_CHANNEL_IMAGE_LIMIT);
  const master = await d.readMaster();
  if (!master || master.spuId !== Number(s.hq_spu_id) || !master.spuCode || !Number.isSafeInteger(master.itemId) || master.itemId<=0)
    throw new Error("HQ image identity mismatch");
  const checkBranch = async () => {
    const branch = await d.readBranch(master.spuCode);
    if (!branch || branch.itemId !== Number(s.branch_item_id) || !s.barcode || branch.barcode !== s.barcode)
      throw new Error("Branch image identity mismatch; no create or relist");
    return branch;
  };
  await checkBranch();
  const materials = await Promise.all(urls.map(url => d.upload(url)));
  const expected = materials.map(m => m.imageUrl);
  await d.assertExclusiveMaster(master.spuCode);
  if (!(await current())) throw new Error("image_revision_superseded");
  await d.updateMaster(master.itemId, materials);
  const verifiedMaster = await d.readMaster();
  const verifiedBranch = await checkBranch();
  if (verifiedMaster?.spuCode !== master.spuCode || JSON.stringify(verifiedMaster?.images) !== JSON.stringify(expected)
      || JSON.stringify(verifiedBranch.images) !== JSON.stringify(expected))
    throw new Error("image_readback_mismatch");
  if (!(await current())) throw new Error("image_revision_superseded");
  return { images_synced: expected.length, images_omitted: sources.length-urls.length };
}

export async function createYouzanImageRefreshDeps(s: ImageSnapshot): Promise<ImageRefreshDeps> {
  const api = await import("@/lib/youzan.functions");
  const media = await import("@/lib/youzan-sync.functions");
  const { parseBranchChannelProduct,isYouzanProductNotFoundError } = await import("@/lib/youzan-offline-products.server");
  const hq = await api.getHqShop();
  if (hq.id !== s.hq_shop_id) throw new Error("hq_shop_mapping_changed");
  const { data: shop, error } = await supabaseAdmin.from("youzan_shops").select("*").eq("id",s.shop_id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!shop || shop.role !== "branch" || shop.status !== "active" || Number(shop.kdt_id) !== Number(s.kdt_id))
    throw new Error("branch_shop_mapping_changed");
  const hqToken = await api.ensureAccessToken(hq);
  let rootItemId: number | null = null;
  const write = async (accessToken: string, method: string, version: string, params: Record<string, unknown>) => {
    const r = await api.callYouzanApiVerbose({ accessToken, method, version, params, timeoutMs: 30_000 });
    if (r.payload === false || (r.payload as { success?: boolean } | null)?.success === false)
      throw new Error("image_update_rejected");
  };
  return {
    origin: getPublicOrigin(),
    readMaster: async () => {
      const master = await media.queryYouzanHqImageMaster(hqToken,Number(s.hq_spu_id));
      if (!master) return null;
      const r = await api.callYouzanApiVerbose({accessToken:hqToken,method:"youzan.item.itemdetail.get",version:"1.0.0",
        params:{request:{kdt_id:Number(hq.kdt_id),item_code:master.spuCode,channel:0}},timeoutMs:20_000});
      const raw = r.payload as any;
      const row = raw?.data ?? raw;
      if (Number(row?.kdt_id)!==Number(hq.kdt_id) || row?.item_code!==master.spuCode || Number(row?.channel)!==0)
        throw new Error("HQ root image identity mismatch");
      rootItemId=Number(row.item_id);
      return {...master,itemId:rootItemId,images:readYouzanImageUrls(row.media?.images)};
    },
    readBranch: async itemCode => {
      const r = await api.callYouzanApiVerbose({ accessToken: hqToken,
        method: "youzan.item.itemdetail.get", version: "1.0.0",
        params: { request: { kdt_id: Number(s.kdt_id), item_code: itemCode, channel: 1 } }, timeoutMs: 20_000 });
      const parsed = parseBranchChannelProduct(r.payload, { kdtId: Number(s.kdt_id), itemCode });
      if (!parsed || rootItemId===null || Number(parsed.libraryItemId)!==rootItemId) return null;
      const raw = r.payload as any;
      const row = raw?.data ?? raw;
      return { itemId: parsed.itemId, barcode: parsed.spuNo || parsed.skus[0]?.skuNo || "",
        images: readYouzanImageUrls(row?.media?.images) };
    },
    assertExclusiveMaster: async itemCode => {
      const r = await supabaseAdmin.from("youzan_shops").select("id,kdt_id")
        .eq("role","branch").eq("status","active");
      if (r.error) throw new Error(r.error.message);
      for (const other of r.data ?? []) {
        if (other.id===s.shop_id) continue;
        if (!Number.isSafeInteger(Number(other.kdt_id)) || Number(other.kdt_id)<=0)
          throw new Error("other_branch_mapping_invalid");
        try {
          const detail = await api.callYouzanApiVerbose({accessToken:hqToken,method:"youzan.item.itemdetail.get",version:"1.0.0",
            params:{request:{kdt_id:Number(other.kdt_id),item_code:itemCode,channel:1}},timeoutMs:20_000});
          const raw=detail.payload as any;
          const row=raw?.data??raw;
          if (Number(row?.kdt_id)!==Number(other.kdt_id) || row?.item_code!==itemCode || Number(row?.channel)!==1)
            throw new Error("other_branch_identity_unverified");
          if (Number(row.display)!==0) throw new Error("image_master_visible_in_other_branch");
        } catch(e) {
          if (!isYouzanProductNotFoundError(e instanceof Error?e.message:String(e))) throw e;
        }
      }
    },
    upload: url => media.uploadImageToYouzanMaterialRecord(hqToken,url,{sku_id:s.sku_id,shop_id:hq.id,kdt_id:hq.kdt_id}),
    // Official common.update: HQ only, omitted fields stay unchanged. Never use a branch token.
    updateMaster: (id,images) => write(hqToken,"youzan.item.common.update","1.0.0",{
      item_id:id,media:{image_ids:images.map(i=>i.imageId)},is_stock_num_edited:false,
    }),
  };
}

export async function enqueueYouzanImageRefresh(skuId: string, shopId: string) {
  const { error } = await supabaseAdmin.rpc("youzan_image_refresh_enqueue" as never,
    { p_sku_id:skuId,p_shop_id:shopId } as never);
  if (error) throw new Error(`image enqueue failed: ${error.message}`);
}

export function imageRefreshWorkerEnabled() {
  return process.env.YOUZAN_IMAGE_REFRESH_WORKER_ENABLED === "true"
    && process.env.HANDHELD_LISTING_IMAGE_WORKER_ENABLED !== "false"
    && process.env.PORT === "3005";
}

export async function runYouzanImageRefreshWorker(limit=2) {
  if (!imageRefreshWorkerEnabled()) return { claimed:0,failed:0,outcomes:[] };
  const { data, error } = await supabaseAdmin.rpc("youzan_image_refresh_claim" as never,
    { p_limit:Number.isFinite(limit)?Math.max(1,Math.min(Math.floor(limit),6)):2 } as never);
  if (error) throw new Error(`image claim failed: ${error.message}`);
  const outcomes: Array<{id:string;status:string}> = [];
  for (const row of (data ?? []) as any[]) {
    let failure: string | null = null;
    let result: {images_synced:number;images_omitted:number} | null = null;
    const args = { p_id:row.id,p_claim_token:row.claim_token,p_revision:row.revision };
    try {
      const snapshot = async () => {
        const r = await supabaseAdmin.rpc("youzan_image_refresh_snapshot" as never,args as never);
        if (r.error) throw new Error(`image snapshot failed: ${r.error.message}`);
        return r.data as unknown as ImageSnapshot | null;
      };
      const s = await snapshot();
      if (s) result=await refreshYouzanImages(s,async()=>JSON.stringify(await snapshot())===JSON.stringify(s),await createYouzanImageRefreshDeps(s));
      else failure="image_target_ineligible_or_revision_superseded";
    } catch (e) { failure=e instanceof Error?e.message:String(e); }
    const finished = await supabaseAdmin.rpc("youzan_image_refresh_finish" as never,{...args,p_error:failure,p_result:result} as never);
    if (finished.error) outcomes.push({id:row.id,status:"finish_failed"});
    else outcomes.push({id:row.id,status:String(finished.data)});
  }
  return { claimed:outcomes.length,failed:outcomes.filter(r=>["retryable_failed","finish_failed"].includes(r.status)).length,outcomes };
}
