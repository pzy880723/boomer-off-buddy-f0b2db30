// ============================================================
// 阶段 2 · 发布链路（HQ 建品 → 分店 release → verify）
// ------------------------------------------------------------
// 这一层是"新 omnichannel 模型"（sku_channel_listings + sales_state）
// 与"旧 sku_youzan_links 主链路"的桥。所有实际 API 调用仍复用
// youzan-sync 里久经考验的 helper，本模块只负责：
//   1) 记录/更新 sku_channel_listings（channel='youzan_hq' | 'youzan_offline'）
//   2) 维护 inv_skus.sales_state / inventory_version
//   3) 对分店链路 verify 后回填 external_item_id / external_sku_id
// ------------------------------------------------------------
// 关键约束（规格 §5-§7）：
//   - HQ SPU 是唯一真源；分店 release = sell_channel_ids 追加分店 kdt
//   - verify = 分店 token 反查 item.detail.get，能拿到 item_id 才算 published
//   - 单件（stock 0/1）：sales_state active/publishing/sold_syncing/sold/return_inspecting/retired
// ============================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin as supabase } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ensureAccessToken,
  explainYouzanError,
  getHqShop,
} from "./youzan.functions";
import { ensureHqSpuLink, ensureBranchProduct, probeBranchRealIds } from "./youzan-sync.functions";

// --- 通用工具 ------------------------------------------------

const HQ_CHANNEL = "youzan_hq";
const BRANCH_CHANNEL = "youzan_offline";

type ListingUpsert = {
  sku_id: string;
  channel: string;
  shop_id: string | null;
  external_spu_id?: string | null;
  external_item_id?: string | null;
  external_sku_id?: string | null;
  listing_status?:
    | "draft"
    | "publishing"
    | "published"
    | "shelved"
    | "unshelved"
    | "delisted"
    | "error";
  last_error?: string | null;
  last_verified_at?: string | null;
  extra?: Record<string, unknown>;
};

async function upsertListing(row: ListingUpsert) {
  // 唯一键：(sku_id, channel, COALESCE(shop_id, zero-uuid))
  // shop_id 为 null 时 Supabase 的 onConflict 语法用 shop_id 直接匹配
  const payload: Record<string, unknown> = {
    sku_id: row.sku_id,
    channel: row.channel,
    shop_id: row.shop_id,
    ...(row.external_spu_id !== undefined ? { external_spu_id: row.external_spu_id } : {}),
    ...(row.external_item_id !== undefined ? { external_item_id: row.external_item_id } : {}),
    ...(row.external_sku_id !== undefined ? { external_sku_id: row.external_sku_id } : {}),
    ...(row.listing_status ? { listing_status: row.listing_status } : {}),
    ...(row.last_error !== undefined ? { last_error: row.last_error } : {}),
    ...(row.last_verified_at !== undefined ? { last_verified_at: row.last_verified_at } : {}),
    ...(row.extra ? { extra: row.extra } : {}),
    updated_at: new Date().toISOString(),
  };

  // 先查是否已存在（避免 onConflict + shop_id NULL 的复杂性）
  const q = supabase
    .from("sku_channel_listings")
    .select("id")
    .eq("sku_id", row.sku_id)
    .eq("channel", row.channel);
  const { data: existing } = await (row.shop_id
    ? q.eq("shop_id", row.shop_id).maybeSingle()
    : q.is("shop_id", null).maybeSingle());

  if (existing?.id) {
    const { data, error } = await supabase
      .from("sku_channel_listings")
      .update(payload as never)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const { data, error } = await supabase
    .from("sku_channel_listings")
    .insert(payload as never)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function setSalesState(
  sku_id: string,
  state: "draft" | "publishing" | "active" | "sold_syncing" | "sold" | "return_inspecting" | "retired",
) {
  await supabase
    .from("inv_skus")
    .update({ sales_state: state, updated_at: new Date().toISOString() } as never)
    .eq("id", sku_id);
}

// --- HQ 发布 -------------------------------------------------

/**
 * 把 SKU 发布到有赞总部（幂等）。
 * - 走 ensureHqSpuLink（复用旧链路建 SPU + 素材上传 + 回填图片）
 * - 成功后镜像到 sku_channel_listings (channel=youzan_hq, shop_id=HQ)
 * - sales_state: draft → publishing → active
 */
export async function publishSkuToHqCore(sku_id: string) {
  const hq = await getHqShop();
  await setSalesState(sku_id, "publishing");
  try {
    const r = await ensureHqSpuLink(sku_id);
    await upsertListing({
      sku_id,
      channel: HQ_CHANNEL,
      shop_id: hq.id,
      external_spu_id: String(r.yz_item_id),
      external_item_id: String(r.yz_item_id),
      external_sku_id: r.yz_sku_id ? String(r.yz_sku_id) : null,
      listing_status: "published",
      last_error: null,
      last_verified_at: new Date().toISOString(),
    });
    await setSalesState(sku_id, "active");
    return { ok: true, spu_id: r.yz_item_id, sku_id: r.yz_sku_id ?? null, created: r.created };
  } catch (e) {
    const msg = explainYouzanError(e);
    await upsertListing({
      sku_id,
      channel: HQ_CHANNEL,
      shop_id: hq.id,
      listing_status: "error",
      last_error: msg.slice(0, 400),
    });
    throw e;
  }
}

export const publishSkuToHq = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sku_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => publishSkuToHqCore(data.sku_id));

// --- 分店 release + verify ----------------------------------

async function probeBranchItemId(params: {
  branch_shop: { id: string; kdt_id: number };
  hq_spu_id: number;
}): Promise<{
  item_id: number;
  sku_id: number;
  attempts: Array<{ label: string; ok: boolean; trace?: string | null; error?: string }>;
} | null> {
  const { branch_shop, hq_spu_id } = params;
  const { data: branchRow } = await supabase
    .from("youzan_shops")
    .select("*")
    .eq("id", branch_shop.id)
    .maybeSingle();
  if (!branchRow) return null;
  const branchToken = await ensureAccessToken(
    branchRow as unknown as Parameters<typeof ensureAccessToken>[0],
  );
  const probe = await probeBranchRealIds({
    hqSpuId: hq_spu_id,
    branchKdtId: branch_shop.kdt_id,
    branchToken,
  });
  if (!probe.item_id) return { item_id: 0, sku_id: 0, attempts: probe.attempts };
  return {
    item_id: probe.item_id,
    sku_id: probe.sku_id || probe.item_id,
    attempts: probe.attempts,
  };
}

/**
 * 把 SKU release 到指定分店（幂等）。
 * - 复用 ensureBranchProduct（把分店 kdt 加进 HQ SPU 的 sell_channel_ids）
 * - 通过分店 token 反查 item.detail.get，拿到分店真实 item_id/sku_id
 * - 镜像到 sku_channel_listings (channel=youzan_offline, shop_id=branch)
 *   listing_status: publishing → published（verify 成功）| unshelved（verify 失败）
 */
export async function releaseSkuToBranchCore(sku_id: string, shop_id: string) {
  const { data: branch } = await supabase
    .from("youzan_shops")
    .select("id, kdt_id, role, shop_name")
    .eq("id", shop_id)
    .maybeSingle();
  if (!branch) throw new Error("门店不存在");
  if ((branch as { role?: string }).role !== "branch") throw new Error("目标店铺不是分店");

  await upsertListing({
    sku_id,
    channel: BRANCH_CHANNEL,
    shop_id,
    listing_status: "publishing",
    last_error: null,
  });

  const r = await ensureBranchProduct(sku_id, shop_id);
  if (!r.yz_item_id) {
    await upsertListing({
      sku_id,
      channel: BRANCH_CHANNEL,
      shop_id,
      listing_status: "error",
      last_error: (r.error || "release 失败").slice(0, 400),
    });
    throw new Error(r.error || "release 失败");
  }

  // Verify via 分店反查
  const probe = await probeBranchItemId({
    branch_shop: { id: (branch as { id: string }).id, kdt_id: Number((branch as { kdt_id: number }).kdt_id) },
    hq_spu_id: r.yz_item_id,
  });

  if (probe && probe.item_id) {
    await upsertListing({
      sku_id,
      channel: BRANCH_CHANNEL,
      shop_id,
      external_spu_id: String(r.yz_item_id),
      external_item_id: String(probe.item_id),
      external_sku_id: String(probe.sku_id),
      listing_status: "published",
      last_error: null,
      last_verified_at: new Date().toISOString(),
    });
    // 回写旧表方便旧 push 链路直接用
    await supabase
      .from("sku_youzan_links")
      .update({
        yz_item_id: probe.item_id,
        yz_sku_id: probe.sku_id,
      } as never)
      .eq("sku_id", sku_id)
      .eq("shop_id", shop_id);
    return {
      ok: true,
      verified: true,
      item_id: probe.item_id,
      sku_id: probe.sku_id,
      probe_attempts: probe.attempts,
    };
  }

  // release 成功但 verify 尚未可见（有赞侧分发有延迟）
  const attempts = probe?.attempts ?? [];
  await upsertListing({
    sku_id,
    channel: BRANCH_CHANNEL,
    shop_id,
    external_spu_id: String(r.yz_item_id),
    listing_status: "unshelved",
    last_error: `release 成功但分店 probe 未返回 item_id：${JSON.stringify(attempts).slice(0, 300)}`,
  });
  return { ok: true, verified: false, spu_id: r.yz_item_id, probe_attempts: attempts };
}

export const releaseSkuToBranch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sku_id: z.string().uuid(), shop_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => releaseSkuToBranchCore(data.sku_id, data.shop_id));

/**
 * Verify 单个 listing —— 通用 worker 里 action='verify_listing' 也会调它
 */
export async function verifyListingCore(listing_id: string) {
  const { data: listing } = await supabase
    .from("sku_channel_listings")
    .select("*")
    .eq("id", listing_id)
    .maybeSingle();
  if (!listing) throw new Error("listing 不存在");
  const l = listing as {
    sku_id: string;
    channel: string;
    shop_id: string | null;
    external_spu_id: string | null;
  };
  if (l.channel !== BRANCH_CHANNEL || !l.shop_id || !l.external_spu_id) {
    return { ok: true, skipped: true };
  }
  const { data: branch } = await supabase
    .from("youzan_shops")
    .select("id, kdt_id")
    .eq("id", l.shop_id)
    .maybeSingle();
  if (!branch) throw new Error("门店不存在");
  const probe = await probeBranchItemId({
    branch_shop: { id: (branch as { id: string }).id, kdt_id: Number((branch as { kdt_id: number }).kdt_id) },
    hq_spu_id: Number(l.external_spu_id),
  });
  if (!probe) {
    await upsertListing({
      sku_id: l.sku_id,
      channel: BRANCH_CHANNEL,
      shop_id: l.shop_id,
      listing_status: "unshelved",
      last_error: "verify 未返回 item_id",
    });
    return { ok: false, verified: false };
  }
  await upsertListing({
    sku_id: l.sku_id,
    channel: BRANCH_CHANNEL,
    shop_id: l.shop_id,
    external_item_id: String(probe.item_id),
    external_sku_id: String(probe.sku_id),
    listing_status: "published",
    last_error: null,
    last_verified_at: new Date().toISOString(),
  });
  return { ok: true, verified: true, item_id: probe.item_id };
}

export const verifyListing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ listing_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => verifyListingCore(data.listing_id));

/**
 * publishSkuEverywhere —— HQ + 所有 default_shop_ids 一键发布
 */
export const publishSkuEverywhere = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sku_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const hq = await publishSkuToHqCore(data.sku_id);
    const { data: sku } = await supabase
      .from("inv_skus")
      .select("default_shop_ids")
      .eq("id", data.sku_id)
      .maybeSingle();
    const shopIds: string[] = Array.isArray((sku as { default_shop_ids?: string[] } | null)?.default_shop_ids)
      ? ((sku as { default_shop_ids: string[] }).default_shop_ids)
      : [];
    const branchResults: Array<{ shop_id: string; ok: boolean; error?: string; verified?: boolean }> = [];
    for (const sid of shopIds) {
      try {
        const r = await releaseSkuToBranchCore(data.sku_id, sid);
        branchResults.push({ shop_id: sid, ok: true, verified: r.verified });
      } catch (e) {
        branchResults.push({
          shop_id: sid,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { hq, branches: branchResults };
  });

/**
 * 列出某 SKU 的全部 listing 状态（前端展示用）
 */
export const listSkuChannelListings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ sku_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabase
      .from("sku_channel_listings")
      .select("*")
      .eq("sku_id", data.sku_id)
      .order("channel", { ascending: true });
    if (error) throw new Error(error.message);
    return { items: rows ?? [] };
  });
