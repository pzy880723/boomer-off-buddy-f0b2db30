// Temporary: POST { shop_id } → dump raw sellchannel.list response for that shop
// Uses that shop's OWN silent token (branch) and falls back to HQ token.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/sellchannel-probe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as { shop_id?: string };
        const shopId = body.shop_id;
        if (!shopId) return Response.json({ ok: false, error: "shop_id required" }, { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: shop, error } = await supabaseAdmin
          .from("youzan_shops")
          .select("id, shop_name, kdt_id, role")
          .eq("id", shopId)
          .maybeSingle();
        if (error || !shop) return Response.json({ ok: false, error: error?.message ?? "shop not found" }, { status: 404 });

        const { fetchSilentToken } = await import("@/lib/youzan.functions");
        const { YZ_GW_URL } = await import("@/lib/youzan.functions");
        const { youzanFetch } = await import("@/lib/youzan-http");

        const out: any = { shop_name: shop.shop_name, kdt_id: shop.kdt_id, role: shop.role, attempts: [] };

        for (const scope of ["branch", "hq"] as const) {
          if (scope === "branch" && shop.role !== "branch") continue;
          if (scope === "hq" && shop.role === "hq") { /* HQ token on HQ shop */ }
          let tokenShop = shop;
          if (scope === "hq" && shop.role !== "hq") {
            const { data: hq } = await supabaseAdmin.from("youzan_shops").select("id, kdt_id").eq("role", "hq").maybeSingle();
            if (!hq) continue;
            tokenShop = { ...shop, kdt_id: hq.kdt_id, role: "hq" } as any;
          }
          let token: string;
          try {
            const t = await fetchSilentToken(tokenShop.kdt_id!);
            token = t.access_token;
          } catch (e) {
            out.attempts.push({ scope, error: `token: ${e instanceof Error ? e.message : String(e)}` });
            continue;
          }
          for (const version of ["1.0.0", "1.0.1"]) {
            for (const params of [{}, { kdt_id: shop.kdt_id }] as Record<string, unknown>[]) {
              const url = `${YZ_GW_URL}/youzan.retail.open.sellchannel.list/${version}?access_token=${encodeURIComponent(token)}`;
              try {
                const res = await youzanFetch(url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(params),
                });
                const text = await res.text();
                out.attempts.push({
                  scope,
                  version,
                  params,
                  http: res.status,
                  body: text.length > 4000 ? text.slice(0, 4000) + "...(truncated)" : text,
                });
              } catch (e) {
                out.attempts.push({ scope, version, params, error: e instanceof Error ? e.message : String(e) });
              }
            }
          }
        }
        return Response.json({ ok: true, ...out });
      },
    },
  },
});
