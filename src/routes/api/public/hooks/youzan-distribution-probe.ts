import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_SKU_ID = "70a6d177-97e7-4e99-be60-4fdcd2453575";
const DEFAULT_BRANCH_SHOP_ID = "da06cdae-5ec1-4749-8dcb-dc972cfd05c9";

type ProbeBody = {
  sku_id?: string;
  branch_shop_id?: string;
  dry_run?: boolean;
};

type Candidate = {
  label: string;
  method: string;
  version: string;
  variants: Array<{
    label: string;
    params: (ctx: ProbeContext) => Record<string, unknown>;
  }>;
};

type ProbeContext = {
  skuId: string;
  skuCode: string;
  hqSpuId: number;
  branchKdtId: number;
  dryRun: boolean;
};

type YouzanVerboseCaller = (opts: {
  accessToken: string;
  method: string;
  version: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<{ payload: unknown; trace_id: string | null; preview: string }>;

type LogClient = {
  from: (table: string) => any;
};

export const Route = createFileRoute("/api/public/hooks/youzan-distribution-probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }

        const body = (await request.json().catch(() => ({}))) as ProbeBody;
        try {
          const out = await runDistributionProbe({
            skuId: body.sku_id ?? DEFAULT_SKU_ID,
            branchShopId: body.branch_shop_id ?? DEFAULT_BRANCH_SHOP_ID,
            dryRun: body.dry_run !== false,
          });
          return Response.json(out);
        } catch (e) {
          return Response.json(
            {
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              stack: e instanceof Error ? e.stack : null,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});

async function runDistributionProbe(opts: {
  skuId: string;
  branchShopId: string;
  dryRun: boolean;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { callYouzanApiVerbose, ensureAccessToken, getHqShop } = await import(
    "@/lib/youzan.functions"
  );
  const { ensureBranchProduct } = await import("@/lib/youzan-sync.functions");

  const hq = await getHqShop();
  const hqToken = await ensureAccessToken(hq);

  const { data: branch, error: branchError } = await supabaseAdmin
    .from("youzan_shops")
    .select("id, kdt_id, shop_name, role")
    .eq("id", opts.branchShopId)
    .maybeSingle();
  if (branchError) throw new Error(branchError.message);
  if (!branch) throw new Error("分店不存在");
  if ((branch as { role?: string }).role !== "branch") throw new Error("目标店铺不是分店");

  const { data: sku, error: skuError } = await supabaseAdmin
    .from("inv_skus")
    .select("id, sku_code, name")
    .eq("id", opts.skuId)
    .maybeSingle();
  if (skuError) throw new Error(skuError.message);
  if (!sku) throw new Error("SKU 不存在");
  const skuCode = String((sku as { sku_code?: string }).sku_code ?? "").trim();
  if (!skuCode) throw new Error("SKU 缺少 sku_code，无法探测铺货接口");

  const ensured = await ensureBranchProduct(opts.skuId, opts.branchShopId);
  if (ensured.error) throw new Error(`ensureBranchProduct 失败：${ensured.error}`);

  const { data: hqLink } = await supabaseAdmin
    .from("sku_youzan_links")
    .select("yz_item_id")
    .eq("sku_id", opts.skuId)
    .eq("shop_id", hq.id)
    .maybeSingle();
  const hqSpuId = Number((hqLink as { yz_item_id?: number } | null)?.yz_item_id ?? ensured.yz_item_id ?? 0);
  if (!hqSpuId) throw new Error("HQ SPU id 缺失，无法探测铺货接口");

  const ctx: ProbeContext = {
    skuId: opts.skuId,
    skuCode,
    hqSpuId,
    branchKdtId: Number((branch as { kdt_id: number }).kdt_id),
    dryRun: opts.dryRun,
  };

  const results: Array<Record<string, unknown>> = [];
  for (const candidate of buildCandidates()) {
    const result = await probeCandidate(candidate, ctx, hqToken, {
      supabaseAdmin,
      branchShopId: opts.branchShopId,
      branchKdtId: ctx.branchKdtId,
      callYouzanApiVerbose,
    });
    results.push(result);
  }

  return {
    ok: results.some((r) => r.ok === true),
    dry_run: opts.dryRun,
    sku_id: opts.skuId,
    sku_code: skuCode,
    hq_spu_id: hqSpuId,
    branch_shop_id: opts.branchShopId,
    branch_kdt_id: ctx.branchKdtId,
    candidates: results,
  };
}

function buildCandidates(): Candidate[] {
  return [
    {
      label: "spu.stores.distribute",
      method: "youzan.retail.open.spu.stores.distribute",
      version: "1.0.0",
      variants: [
        {
          label: "spu_id+store_kdt_ids",
          params: (c) => ({
            spu_id: c.hqSpuId,
            store_kdt_ids: [c.branchKdtId],
          }),
        },
        {
          label: "spu_code+kdt_ids",
          params: (c) => ({
            spu_code: c.skuCode,
            kdt_ids: [c.branchKdtId],
          }),
        },
      ],
    },
    {
      label: "spu.publish.to.stores",
      method: "youzan.retail.open.spu.publish.to.stores",
      version: "1.0.0",
      variants: [
        {
          label: "spu_id+store_kdt_ids",
          params: (c) => ({
            spu_id: c.hqSpuId,
            store_kdt_ids: [c.branchKdtId],
          }),
        },
        {
          label: "spu_id+target_kdt_ids",
          params: (c) => ({
            spu_id: c.hqSpuId,
            target_kdt_ids: [c.branchKdtId],
          }),
        },
      ],
    },
    {
      label: "product.dispatch",
      method: "youzan.retail.open.product.dispatch",
      version: "1.0.0",
      variants: [
        {
          label: "spu_id+kdt_id",
          params: (c) => ({
            spu_id: c.hqSpuId,
            kdt_id: c.branchKdtId,
          }),
        },
        {
          label: "spu_id+target_kdt_ids",
          params: (c) => ({
            spu_id: c.hqSpuId,
            target_kdt_ids: [c.branchKdtId],
          }),
        },
      ],
    },
  ];
}

async function probeCandidate(
  candidate: Candidate,
  ctx: ProbeContext,
  hqToken: string,
  deps: {
    supabaseAdmin: LogClient;
    branchShopId: string;
    branchKdtId: number;
    callYouzanApiVerbose: YouzanVerboseCaller;
  },
) {
  const { data: log } = await deps.supabaseAdmin
    .from("youzan_sync_logs")
    .insert({
      shop_id: deps.branchShopId,
      kdt_id: deps.branchKdtId,
      action: "distribution_probe",
      status: "running",
      message: `${candidate.method}/${candidate.version} probing`,
    } as never)
    .select("id")
    .single();

  const attempts: Array<Record<string, unknown>> = [];
  for (const variant of candidate.variants) {
    const params = variant.params(ctx);
    try {
      const res = await deps.callYouzanApiVerbose({
        accessToken: hqToken,
        method: candidate.method,
        version: candidate.version,
        params,
        timeoutMs: 12_000,
      });
      const okAttempt = {
        label: variant.label,
        ok: true,
        params,
        trace_id: res.trace_id,
        preview: res.preview.slice(0, 500),
      };
      attempts.push(okAttempt);
      await finishProbeLog(deps.supabaseAdmin, log?.id as string | undefined, {
        status: "ok",
        message: JSON.stringify({ method: candidate.method, version: candidate.version, ...okAttempt }).slice(0, 3500),
        error: null,
      });
      return { method: candidate.method, version: candidate.version, ok: true, attempts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const failedAttempt = {
        label: variant.label,
        ok: false,
        params,
        error: msg.slice(0, 1000),
      };
      attempts.push(failedAttempt);
      if (!shouldTryNextVariant(msg)) break;
    }
  }

  const error = JSON.stringify({ method: candidate.method, version: candidate.version, attempts }).slice(0, 3500);
  await finishProbeLog(deps.supabaseAdmin, log?.id as string | undefined, {
    status: "error",
    message: `${candidate.method}/${candidate.version} unavailable`,
    error,
  });
  return { method: candidate.method, version: candidate.version, ok: false, attempts };
}

function shouldTryNextVariant(message: string) {
  return /参数|缺少|缺失|required|invalid\s*param|is\s*null|不能为空|类型|格式/i.test(message);
}

async function finishProbeLog(
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