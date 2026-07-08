// 一次性：把两个中信泰富的测试 SKU 从有赞总部彻底重建 → 铺货到分店 → 推库存 = 1
// POST /api/public/hooks/youzan-relist   apikey 头 = SUPABASE_PUBLISHABLE_KEY
// body 可选：{ sku_ids?: string[], branch_shop_id?: string, target_stock?: number, delete_existing?: boolean }
import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_SKU_IDS = [
  "70a6d177-97e7-4e99-be60-4fdcd2453575", // 测试商品
  "8ef769b3-51dc-4576-b1f2-2c061dee74c2", // test
];
const DEFAULT_BRANCH = "da06cdae-5ec1-4749-8dcb-dc972cfd05c9"; // 中信泰富店

export const Route = createFileRoute("/api/public/hooks/youzan-relist")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const body = (await request.json().catch(() => ({}))) as {
          sku_ids?: string[];
          branch_shop_id?: string;
          target_stock?: number;
          delete_existing?: boolean;
        };
        const sku_ids =
          Array.isArray(body.sku_ids) && body.sku_ids.length > 0
            ? body.sku_ids
            : DEFAULT_SKU_IDS;
        const branch_shop_id = body.branch_shop_id ?? DEFAULT_BRANCH;
        const target_stock = typeof body.target_stock === "number" ? body.target_stock : 1;
        const delete_existing = body.delete_existing !== false;

        try {
          const out = await run({ sku_ids, branch_shop_id, target_stock, delete_existing });
          return Response.json(out);
        } catch (e) {
          return Response.json(
            {
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

async function run(opts: {
  sku_ids: string[];
  branch_shop_id: string;
  target_stock: number;
  delete_existing: boolean;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { callYouzanApiVerbose, ensureAccessToken, getHqShop } = await import(
    "@/lib/youzan.functions"
  );
  const { ensureBranchProduct } = await import("@/lib/youzan-sync.functions");

  const steps: Array<Record<string, unknown>> = [];
  const hq = await getHqShop();
  const hqToken = await ensureAccessToken(hq);

  // 拿 sku_code 便于后续用 spu_code 删除/查
  const { data: skus } = await supabaseAdmin
    .from("inv_skus")
    .select("id, sku_code, name")
    .in("id", opts.sku_ids);
  const skuMap = new Map<string, { sku_code: string; name: string }>(
    (skus ?? []).map((s) => [
      s.id as string,
      { sku_code: (s as { sku_code: string }).sku_code, name: (s as { name: string }).name },
    ]),
  );

  // Step 1: 删除有赞总部现存 SPU（按 spu_code = 本地 sku_code）
  if (opts.delete_existing) {
    for (const sku_id of opts.sku_ids) {
      const s = skuMap.get(sku_id);
      if (!s) continue;
      try {
        const res = await callYouzanApiVerbose({
          accessToken: hqToken,
          method: "youzan.retail.open.spu.delete",
          version: "3.0.0",
          params: { spu_codes: [s.sku_code] },
          timeoutMs: 20_000,
        });
        steps.push({ step: "spu.delete", sku_id, ok: true, preview: res.preview.slice(0, 200) });
      } catch (e) {
        steps.push({
          step: "spu.delete",
          sku_id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // Step 2: 清掉本地 links 和 queue
  await supabaseAdmin.from("sku_youzan_links").delete().in("sku_id", opts.sku_ids);
  await supabaseAdmin
    .from("youzan_stock_sync_queue")
    .delete()
    .in("sku_id", opts.sku_ids)
    .eq("shop_id", opts.branch_shop_id);
  steps.push({ step: "clear_local_links_and_queue", ok: true });

  // Step 3: 对每个 SKU 走 ensureBranchProduct（建 HQ SPU + 追加分店）
  const productResults: Array<Record<string, unknown>> = [];
  for (const sku_id of opts.sku_ids) {
    const r = await ensureBranchProduct(sku_id, opts.branch_shop_id);
    productResults.push({ sku_id, ...r });
  }
  steps.push({ step: "ensureBranchProduct", results: productResults });

  // Step 4: 直接内联推库存（不走 queue），拿到 trace_id 立刻回报
  // 2026-07 audit：用【分店 token】+ item.detail.get 反查真实 branch item_id
  const stockResults: Array<Record<string, unknown>> = [];
  for (const sku_id of opts.sku_ids) {
    const { data: link } = await supabaseAdmin
      .from("sku_youzan_links")
      .select("id, sku_id, shop_id, yz_item_id, yz_sku_id")
      .eq("sku_id", sku_id)
      .eq("shop_id", opts.branch_shop_id)
      .maybeSingle();
    if (!link || !(link as { yz_item_id?: number }).yz_item_id) {
      stockResults.push({ sku_id, ok: false, error: "no branch link" });
      continue;
    }
    const branchRow = await supabaseAdmin
      .from("youzan_shops")
      .select("*")
      .eq("id", opts.branch_shop_id)
      .maybeSingle();
    const branchShop = branchRow.data as {
      id: string;
      kdt_id: number;
      access_token: string | null;
      refresh_token: string | null;
      token_expires_at: string | null;
    };
    const branchToken = await ensureAccessToken(branchShop as never);
    const hqSpuId = Number((link as { yz_item_id: number }).yz_item_id);

    // 反查分店真实 item_id
    let branchItemId = 0;
    let branchSkuId = 0;
    let detailPreview = "";
    try {
      const detail = await callYouzanApiVerbose({
        accessToken: branchToken,
        method: "youzan.item.detail.get",
        version: "1.0.0",
        params: { node_kdt_id: branchShop.kdt_id, spu_id: hqSpuId },
        timeoutMs: 20_000,
      });
      detailPreview = detail.preview.slice(0, 200);
      const seen = new Set<unknown>();
      const walk = (v: unknown, depth = 0) => {
        if (!v || typeof v !== "object" || depth > 6 || seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v)) {
          for (const el of v) walk(el, depth + 1);
          return;
        }
        const obj = v as Record<string, unknown>;
        for (const k of ["item_id", "itemId", "num_iid", "id"]) {
          if (!branchItemId) {
            const n = Number(obj[k]);
            if (n > 0) branchItemId = n;
          }
        }
        for (const k of ["sku_id", "skuId"]) {
          if (!branchSkuId) {
            const n = Number(obj[k]);
            if (n > 0) branchSkuId = n;
          }
        }
        for (const val of Object.values(obj)) walk(val, depth + 1);
      };
      walk(detail.payload);
    } catch (e) {
      stockResults.push({
        sku_id,
        ok: false,
        error: `branch item not visible / distribution missing：${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    if (!branchItemId) {
      stockResults.push({
        sku_id,
        ok: false,
        error: `branch item not visible / distribution missing：detail.get 未返回 item_id (spu_id=${hqSpuId})`,
        detail_preview: detailPreview,
      });
      continue;
    }
    if (!branchSkuId) branchSkuId = branchItemId; // 无 SKU 商品

    // 回写真实 branch id
    await supabaseAdmin
      .from("sku_youzan_links")
      .update({ yz_item_id: branchItemId, yz_sku_id: branchSkuId } as never)
      .eq("id", (link as { id: string }).id);

    const params = {
      kdt_id: branchShop.kdt_id,
      item_id: branchItemId,
      sku_id: branchSkuId,
      channel: 1,
      stock_num_str: String(Math.max(0, opts.target_stock)),
    };
    try {
      const r = await callYouzanApiVerbose({
        accessToken: branchToken,
        method: "youzan.item.quantity.update",
        version: "4.0.0",
        params,
        timeoutMs: 20_000,
      });
      stockResults.push({
        sku_id,
        ok: true,
        params,
        trace_id: r.trace_id,
        preview: r.preview.slice(0, 200),
      });
    } catch (e) {
      stockResults.push({
        sku_id,
        ok: false,
        params,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  steps.push({ step: "quantity.update", results: stockResults });

  return { ok: true, steps };
}

