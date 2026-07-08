// 一次性清理脚本：删除有赞总部误建的 SPU（按名称白名单，保护已绑定 spu_id）
// 使用：POST /api/public/hooks/youzan-cleanup  body: { names:[...], dry_run?:true }
// 用 apikey = SUPABASE_PUBLISHABLE_KEY 简单验证
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/youzan-cleanup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const body = (await request.json().catch(() => ({}))) as {
          names?: string[];
          dry_run?: boolean;
        };
        const names = Array.isArray(body.names) && body.names.length > 0
          ? body.names
          : ["probe-channel-a", "probe-channel-b", "probe-channel-c", "test", "测试商品"];
        const dry_run = body.dry_run !== false; // 默认 dry-run，安全兜底

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { callYouzanApiVerbose, ensureAccessToken, getHqShop } = await import(
          "@/lib/youzan.functions"
        );

        const hq = await getHqShop();
        const token = await ensureAccessToken(hq);

        // 拉取总部所有 SPU
        const allRows: Array<Record<string, unknown>> = [];
        for (let page = 1; page <= 5; page += 1) {
          const res = await callYouzanApiVerbose({
            accessToken: token,
            method: "youzan.retail.open.spu.query",
            version: "3.0.0",
            params: { page_no: page, page_size: 100 },
            timeoutMs: 25_000,
          });
          const rows = collectSpuRows(res.payload);
          if (!rows.length) break;
          allRows.push(...rows);
          if (rows.length < 100) break;
        }

        const { data: linked } = await supabaseAdmin
          .from("sku_youzan_links")
          .select("yz_item_id")
          .eq("role", "hq_spu");
        const protectedIds = new Set(
          (linked ?? [])
            .map((r: { yz_item_id: number | null }) => Number(r.yz_item_id))
            .filter((n) => n > 0),
        );

        const wanted = new Set(names.map((s) => s.trim()));
        const candidates = allRows
          .map((row) => {
            const name = String(
              row.product_name ?? row.productName ?? row.name ?? row.title ?? "",
            ).trim();
            const spuId = Number(
              row.spu_id ?? row.spuId ?? row.item_id ?? row.id ?? 0,
            );
            return { name, spuId };
          })
          .filter((r) => r.spuId > 0 && wanted.has(r.name));

        const toDelete = candidates.filter((r) => !protectedIds.has(r.spuId));
        const kept = candidates.filter((r) => protectedIds.has(r.spuId));

        if (dry_run) {
          return Response.json({
            dry_run: true,
            total_scanned: allRows.length,
            protected_ids: [...protectedIds],
            matched: candidates,
            kept,
            will_delete: toDelete,
          });
        }

        const results: Array<{
          spuId: number;
          name: string;
          ok: boolean;
          message: string;
        }> = [];
        for (const item of toDelete) {
          let ok = false;
          let message = "";
          const attempts: Array<{ method: string; version: string; params: Record<string, unknown> }> = [
            {
              method: "youzan.retail.open.spu.delete",
              version: "3.0.0",
              params: { spu_id: item.spuId },
            },
            {
              method: "youzan.retail.open.spu.delete",
              version: "1.0.0",
              params: { spu_id: item.spuId },
            },
            {
              method: "youzan.retail.open.product.delete",
              version: "1.0.0",
              params: { kdt_id: hq.kdt_id, spu_id: item.spuId },
            },
            {
              method: "youzan.item.delete",
              version: "3.0.0",
              params: { item_id: item.spuId },
            },
          ];
          for (const a of attempts) {
            try {
              const res = await callYouzanApiVerbose({
                accessToken: token,
                method: a.method,
                version: a.version,
                params: a.params,
                timeoutMs: 20_000,
              });
              message = `${a.method}/${a.version} → ${res.preview.slice(0, 200)}`;
              if (!/error|fail|非法|不存在|4005|4001|123000|success":\s*false/i.test(res.preview)) {
                ok = true;
                break;
              }
            } catch (e) {
              message = `${a.method}/${a.version}: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          results.push({ spuId: item.spuId, name: item.name, ok, message });
        }

        return Response.json({
          dry_run: false,
          total_scanned: allRows.length,
          matched: candidates,
          kept,
          results,
        });
      },
    },
  },
});

function collectSpuRows(payload: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const keys = ["spus", "spu_list", "spuList", "items", "list", "records"];
  const walk = (value: unknown, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          rows.push(item as Record<string, unknown>);
        }
      }
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const key of keys) walk(obj[key], depth + 1);
    for (const key of ["data", "response", "result"]) walk(obj[key], depth + 1);
  };
  walk(payload);
  return rows;
}
