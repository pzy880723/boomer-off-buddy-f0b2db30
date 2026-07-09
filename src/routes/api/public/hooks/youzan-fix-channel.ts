import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_SKU_IDS = ["70a6d177-97e7-4e99-be60-4fdcd2453575"];
const DEFAULT_BRANCH_SHOP_ID = "da06cdae-5ec1-4749-8dcb-dc972cfd05c9";

type Body = {
  sku_ids?: string[];
  branch_shop_id?: string;
  dry_run?: boolean;
  stock_num_str?: string;
};

type LogClient = { from: (table: string) => any };
type YouzanVerboseCaller = (opts: {
  accessToken: string;
  method: string;
  version: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<{ payload: unknown; trace_id: string | null; preview: string }>;

export const Route = createFileRoute("/api/public/hooks/youzan-fix-channel")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const body = (await request.json().catch(() => ({}))) as Body;
        try {
          const out = await run({
            skuIds: body.sku_ids && body.sku_ids.length ? body.sku_ids : DEFAULT_SKU_IDS,
            branchShopId: body.branch_shop_id ?? DEFAULT_BRANCH_SHOP_ID,
            dryRun: body.dry_run === true,
            stockNumStr: body.stock_num_str,
          });
          return Response.json(out);
        } catch (e) {
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : null },
            { status: 500 },
          );
        }
      },
    },
  },
});

async function run(opts: {
  skuIds: string[];
  branchShopId: string;
  dryRun: boolean;
  stockNumStr?: string;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { callYouzanApiVerbose, ensureAccessToken, getHqShop } = await import(
    "@/lib/youzan.functions"
  );

  const hq = await getHqShop();
  const hqToken = await ensureAccessToken(hq);

  const [{ data: branch, error: branchError }, { data: catSetting }] = await Promise.all([
    supabaseAdmin
      .from("youzan_shops")
      .select("id, kdt_id, shop_name, role")
      .eq("id", opts.branchShopId)
      .maybeSingle(),
    supabaseAdmin
      .from("app_settings")
      .select("value")
      .eq("key", "youzan_hq_default_category_id")
      .maybeSingle(),
  ]);
  if (branchError) throw new Error(branchError.message);
  if (!branch) throw new Error("分店不存在");
  const branchRow = branch as { id: string; kdt_id: number; shop_name: string; role?: string };
  if (branchRow.role !== "branch") throw new Error("目标 shop 不是 branch");
  const branchKdtId = Number(branchRow.kdt_id);

  const catValue = (catSetting as { value?: any } | null)?.value;
  const defaultCategoryId = Number(
    typeof catValue === "number"
      ? catValue
      : typeof catValue === "string"
        ? catValue
        : catValue && typeof catValue === "object"
          ? catValue.id
          : 0,
  );
  if (!defaultCategoryId) throw new Error("app_settings.youzan_hq_default_category_id 未配置");


  // ---- Step 1: 组织树，解析 sell_channel_id ----
  const orgResult = await fetchOrganizationTree({
    supabaseAdmin,
    callYouzanApiVerbose,
    hqToken,
    branchShopId: opts.branchShopId,
    branchKdtId,
  });
  if (!orgResult.ok) {
    return {
      ok: false,
      stage: "chain_organization_list",
      branch: { shop_id: opts.branchShopId, kdt_id: branchKdtId, sell_channel_id: null },
      error: orgResult.error,
      matched_node: orgResult.matchedNode ?? null,
      trace_id: orgResult.traceId,
    };
  }
  const branchSellChannelId = orgResult.sellChannelId!;
  const branchInfo = {
    shop_id: opts.branchShopId,
    kdt_id: branchKdtId,
    sell_channel_id: branchSellChannelId,
    matched_node: orgResult.matchedNode,
  };

  // ---- Step 2: 分店 token（step 4/5 用）----
  const branchTokenRow = branchRow as any;
  const branchToken = await ensureAccessToken(branchTokenRow);

  // ---- Step 3-5: 逐个 SKU ----
  const results: Array<Record<string, unknown>> = [];
  for (const skuId of opts.skuIds) {
    const perSku: Record<string, unknown> = { sku_id: skuId };

    // 拿 HQ SPU id + SKU 基础信息
    const [{ data: hqLink }, { data: skuRow }] = await Promise.all([
      supabaseAdmin
        .from("sku_youzan_links")
        .select("yz_item_id")
        .eq("sku_id", skuId)
        .eq("shop_id", hq.id)
        .maybeSingle(),
      supabaseAdmin
        .from("inv_skus")
        .select("name")
        .eq("id", skuId)
        .maybeSingle(),
    ]);
    const hqSpuId = Number((hqLink as { yz_item_id?: number } | null)?.yz_item_id ?? 0);
    if (!hqSpuId) {
      perSku.hq_spu_id = null;
      perSku.error = "HQ SPU id 缺失，先运行建品流程";
      results.push(perSku);
      continue;
    }
    perSku.hq_spu_id = hqSpuId;
    const skuName = String((skuRow as { name?: string } | null)?.name ?? "").trim() || `SPU ${hqSpuId}`;
    const steps: Record<string, unknown> = {};

    // Step 3: fix sell channel
    steps.fix_channel = await fixSellChannel({
      supabaseAdmin,
      callYouzanApiVerbose,
      hqToken,
      branchShopId: opts.branchShopId,
      branchKdtId,
      hqSpuId,
      sellChannelId: branchSellChannelId,
      spuName: skuName,
      spuUnit: "件",
      categoryId: defaultCategoryId,
      dryRun: opts.dryRun,
    });
    if ((steps.fix_channel as any).ok !== true) {
      perSku.steps = steps;
      results.push(perSku);
      continue;
    }

    // Step 4: probe branch item
    const probe = await probeBranchItem({
      supabaseAdmin,
      callYouzanApiVerbose,
      branchToken,
      branchShopId: opts.branchShopId,
      branchKdtId,
      hqSpuId,
      skuId,
      dryRun: opts.dryRun,
    });
    steps.branch_probe = probe;
    if (!probe.ok) {
      perSku.steps = steps;
      perSku.error = "branch item not visible";
      results.push(perSku);
      continue;
    }

    // Step 5: quantity update
    const stockStr = opts.stockNumStr ?? "1";
    steps.quantity_update = await pushQuantity({
      supabaseAdmin,
      callYouzanApiVerbose,
      branchToken,
      branchShopId: opts.branchShopId,
      branchKdtId,
      itemId: probe.item_id!,
      skuId: probe.sku_id ?? probe.item_id!,
      stockNumStr: stockStr,
      dryRun: opts.dryRun,
    });

    perSku.steps = steps;
    results.push(perSku);
  }

  return {
    ok: results.every(
      (r) => (r as any).steps && ((r as any).steps.quantity_update?.ok || (r as any).steps.quantity_update === undefined ? true : false),
    ) && results.every((r) => !(r as any).error),
    dry_run: opts.dryRun,
    branch: branchInfo,
    results,
  };
}

// ---------- helpers ----------

async function fetchOrganizationTree(deps: {
  supabaseAdmin: LogClient;
  callYouzanApiVerbose: YouzanVerboseCaller;
  hqToken: string;
  branchShopId: string;
  branchKdtId: number;
}): Promise<{
  ok: boolean;
  sellChannelId?: number;
  matchedNode?: unknown;
  error?: string;
  traceId: string | null;
}> {
  const { data: log } = await deps.supabaseAdmin
    .from("youzan_sync_logs")
    .insert({
      shop_id: deps.branchShopId,
      kdt_id: deps.branchKdtId,
      action: "chain_organization_list",
      status: "running",
      message: `resolve sell_channel_id for kdt_id=${deps.branchKdtId}`,
    } as never)
    .select("id")
    .single();

  // 试探性调用：能拿到组织树最好，拿不到就用 kdt_id 兜底。
  // 已知这些 API 在当前授权下全部返回 gw 4005；此处保留调用只是为了留 trace，
  // 真正生效的 sell_channel_id 直接用分店 kdt_id（有赞连锁零售的默认对齐关系）。
  let matched: unknown = null;
  let channelId: number | null = null;
  let traceId: string | null = null;
  let probeError: string | null = null;

  try {
    const res = await deps.callYouzanApiVerbose({
      accessToken: deps.hqToken,
      method: "youzan.shop.get",
      version: "3.0.0",
      params: { kdt_id: deps.branchKdtId },
      timeoutMs: 12_000,
    });
    traceId = res.trace_id;
    matched = findNodeByKdt(res.payload, deps.branchKdtId) ?? res.payload;
    channelId = matched && typeof matched === "object" ? findChannelId(matched as Record<string, unknown>) : null;
  } catch (e) {
    probeError = e instanceof Error ? e.message : String(e);
  }

  const resolvedChannelId = channelId ?? deps.branchKdtId;
  const usedFallback = channelId === null;

  await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
    status: "ok",
    message: JSON.stringify({
      trace_id: traceId,
      resolved_sell_channel_id: resolvedChannelId,
      via: usedFallback ? "fallback_kdt_id" : "shop.get",
      probe_error: probeError,
    }).slice(0, 3500),
    error: null,
  });

  return {
    ok: true,
    sellChannelId: resolvedChannelId,
    matchedNode: matched ?? { fallback: true, kdt_id: deps.branchKdtId },
    traceId,
  };
}

async function fixSellChannel(deps: {
  supabaseAdmin: LogClient;
  callYouzanApiVerbose: YouzanVerboseCaller;
  hqToken: string;
  branchShopId: string;
  branchKdtId: number;
  hqSpuId: number;
  sellChannelId: number;
  spuName: string;
  spuUnit: string;
  categoryId: number;
  dryRun: boolean;
}) {
  const params: Record<string, unknown> = {
    spu_id: deps.hqSpuId,
    name: deps.spuName,
    unit: deps.spuUnit || "件",
    category_id: deps.categoryId,
    sell_channel_setting_request: {
      is_partial: 1,
      sell_channel_ids: [deps.sellChannelId],
    },
  };
  if (deps.dryRun) {
    return { ok: true, dry_run: true, params };
  }

  const { data: log } = await deps.supabaseAdmin
    .from("youzan_sync_logs")
    .insert({
      shop_id: deps.branchShopId,
      kdt_id: deps.branchKdtId,
      action: "fix_sell_channel",
      status: "running",
      message: `spu.update spu_id=${deps.hqSpuId} sell_channel_id=${deps.sellChannelId}`,
    } as never)
    .select("id")
    .single();

  try {
    const res = await deps.callYouzanApiVerbose({
      accessToken: deps.hqToken,
      method: "youzan.retail.open.spu.update",
      version: "3.0.0",
      params,
      timeoutMs: 15_000,
    });
    await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
      status: "ok",
      message: JSON.stringify({ trace_id: res.trace_id, preview: res.preview.slice(0, 1200) }).slice(0, 3500),
      error: null,
    });
    return { ok: true, trace_id: res.trace_id, params };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
      status: "error",
      message: "spu.update failed",
      error: msg.slice(0, 3000),
    });
    return { ok: false, error: msg, params };
  }
}

async function probeBranchItem(deps: {
  supabaseAdmin: LogClient;
  callYouzanApiVerbose: YouzanVerboseCaller;
  branchToken: string;
  branchShopId: string;
  branchKdtId: number;
  hqSpuId: number;
  skuId: string;
  dryRun: boolean;
}): Promise<{ ok: boolean; item_id?: string; sku_id?: string; error?: string; trace_id?: string | null }> {
  const params = { node_kdt_id: deps.branchKdtId, spu_id: deps.hqSpuId };

  const { data: log } = await deps.supabaseAdmin
    .from("youzan_sync_logs")
    .insert({
      shop_id: deps.branchShopId,
      kdt_id: deps.branchKdtId,
      action: "branch_item_probe",
      status: "running",
      message: `item.detail.get spu_id=${deps.hqSpuId}`,
    } as never)
    .select("id")
    .single();

  try {
    const res = await deps.callYouzanApiVerbose({
      accessToken: deps.branchToken,
      method: "youzan.item.detail.get",
      version: "1.0.0",
      params,
      timeoutMs: 15_000,
    });
    const itemId = pickString(res.payload, ["item_id", "num_iid", "itemId"]);
    const skuId = pickString(res.payload, ["sku_id", "skuId"]);
    if (!itemId) {
      await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
        status: "error",
        message: JSON.stringify({ trace_id: res.trace_id, preview: res.preview.slice(0, 1500) }).slice(0, 3500),
        error: "branch item not visible: item_id missing in response",
      });
      return { ok: false, error: "branch item not visible", trace_id: res.trace_id };
    }

    // 回写 sku_youzan_links(role='branch_stock')
    if (!deps.dryRun) {
      await deps.supabaseAdmin
        .from("sku_youzan_links")
        .upsert(
          {
            sku_id: deps.skuId,
            shop_id: deps.branchShopId,
            role: "branch_stock",
            yz_item_id: itemId,
            yz_sku_id: skuId ?? itemId,
            sync_stock: true,
          } as never,
          { onConflict: "sku_id,shop_id" } as never,
        );
    }

    await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
      status: "ok",
      message: JSON.stringify({ trace_id: res.trace_id, item_id: itemId, sku_id: skuId }).slice(0, 3500),
      error: null,
    });
    return { ok: true, item_id: itemId, sku_id: skuId ?? undefined, trace_id: res.trace_id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
      status: "error",
      message: "item.detail.get failed",
      error: msg.slice(0, 3000),
    });
    return { ok: false, error: msg };
  }
}

async function pushQuantity(deps: {
  supabaseAdmin: LogClient;
  callYouzanApiVerbose: YouzanVerboseCaller;
  branchToken: string;
  branchShopId: string;
  branchKdtId: number;
  itemId: string;
  skuId: string;
  stockNumStr: string;
  dryRun: boolean;
}) {
  const params = {
    kdt_id: deps.branchKdtId,
    item_id: deps.itemId,
    sku_id: deps.skuId,
    channel: 1,
    stock_num_str: deps.stockNumStr,
  };
  if (deps.dryRun) return { ok: true, dry_run: true, params };

  const { data: log } = await deps.supabaseAdmin
    .from("youzan_sync_logs")
    .insert({
      shop_id: deps.branchShopId,
      kdt_id: deps.branchKdtId,
      action: "quantity_update",
      status: "running",
      message: `item.quantity.update item_id=${deps.itemId} stock=${deps.stockNumStr}`,
    } as never)
    .select("id")
    .single();

  try {
    const res = await deps.callYouzanApiVerbose({
      accessToken: deps.branchToken,
      method: "youzan.item.quantity.update",
      version: "4.0.0",
      params,
      timeoutMs: 15_000,
    });
    await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
      status: "ok",
      message: JSON.stringify({ trace_id: res.trace_id, preview: res.preview.slice(0, 1200) }).slice(0, 3500),
      error: null,
    });
    return { ok: true, trace_id: res.trace_id, params };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishLog(deps.supabaseAdmin, log?.id as string | undefined, {
      status: "error",
      message: "item.quantity.update failed",
      error: msg.slice(0, 3000),
    });
    return { ok: false, error: msg, params };
  }
}

async function finishLog(
  supabaseAdmin: LogClient,
  id: string | undefined,
  patch: { status: "ok" | "error"; message: string; error: string | null },
) {
  if (!id) return;
  await supabaseAdmin
    .from("youzan_sync_logs")
    .update({
      status: patch.status,
      message: patch.message,
      error: patch.error,
      finished_at: new Date().toISOString(),
    } as never)
    .eq("id", id);
}

// ---- payload walkers ----
function findNodeByKdt(payload: unknown, targetKdt: number): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  walk(payload, (node) => {
    if (found) return;
    if (typeof node === "object" && node && !Array.isArray(node)) {
      const rec = node as Record<string, unknown>;
      const kdt = Number(rec.kdt_id ?? rec.kdtId ?? rec.shop_id ?? rec.shopId);
      if (Number.isFinite(kdt) && kdt === targetKdt) found = rec;
    }
  });
  return found;
}

function findChannelId(node: Record<string, unknown>): number | null {
  let found: number | null = null;
  walk(node, (n) => {
    if (found !== null) return;
    if (typeof n === "object" && n && !Array.isArray(n)) {
      const rec = n as Record<string, unknown>;
      for (const k of ["sell_channel_id", "sellChannelId", "channel_id", "channelId"]) {
        const v = rec[k];
        const num = typeof v === "string" ? Number(v) : (v as number);
        if (typeof num === "number" && Number.isFinite(num)) {
          found = num;
          return;
        }
      }
    }
  });
  return found;
}

function pickString(payload: unknown, keys: string[]): string | undefined {
  let found: string | undefined;
  walk(payload, (n) => {
    if (found) return;
    if (typeof n === "object" && n && !Array.isArray(n)) {
      const rec = n as Record<string, unknown>;
      for (const k of keys) {
        const v = rec[k];
        if (v === null || v === undefined) continue;
        const s = String(v).trim();
        if (s && s !== "0") {
          found = s;
          return;
        }
      }
    }
  });
  return found;
}

function walk(node: unknown, visit: (n: unknown) => void) {
  visit(node);
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) walk(v, visit);
  }
}
