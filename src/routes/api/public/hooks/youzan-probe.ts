import { createFileRoute } from "@tanstack/react-router";

// 临时诊断：探测总部 token 对几个关键 API 的权限，返回原始响应
export const Route = createFileRoute("/api/public/hooks/youzan-probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("unauthorized", { status: 401 });
        }
        const { callYouzanApiVerbose, ensureAccessToken, getHqShop } =
          await import("@/lib/youzan.functions");

        const hq = await getHqShop();
        const token = await ensureAccessToken(hq);

        async function probe(method: string, version: string, params: Record<string, unknown>) {
          try {
            const res = await callYouzanApiVerbose({
              accessToken: token,
              method,
              version,
              params,
              timeoutMs: 20_000,
            });
            return { method, version, ok: true, preview: res.preview?.slice?.(0, 500) };
          } catch (e) {
            return { method, version, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }

        const results = [
          await probe("youzan.item.group.get", "3.0.0", {}),
          await probe("youzan.item.group.create", "3.0.0", { group_name: "ERP自动同步", parent_id: 0 }),
          await probe("youzan.retail.open.spu.create", "3.0.0", {
            title: "__probe_do_not_use__",
            outer_id: "PROBE-" + Date.now(),
            offline_create: true,
            sku: [{ outer_id: "PROBE-SKU", price: 1, quantity: 0 }],
          }),
        ];

        return Response.json({ hq_kdt_id: hq.kdt_id, results });
      },
    },
  },
});
