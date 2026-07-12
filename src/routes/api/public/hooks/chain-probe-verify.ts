// Temporary verification endpoint — POST here to run probeShopChainOrgList
// against the given branch shop_id and see the full raw attempts array.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/chain-probe-verify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json().catch(() => ({}));
        const shopId: string | undefined = body?.shop_id;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        let shop: any = null;
        if (shopId) {
          const { data } = await supabaseAdmin
            .from("youzan_shops")
            .select("*")
            .eq("id", shopId)
            .maybeSingle();
          shop = data ?? null;
        }
        // Dynamic import so we don't leak server-only code into client
        const mod: any = await import("@/lib/integration-capabilities.functions");
        // @ts-expect-error — internal helper exported for verification only
        const probe = mod.__probeShopChainOrgList ?? mod.probeShopChainOrgList;
        if (typeof probe !== "function") {
          return Response.json({ ok: false, error: "probe helper not exported" }, { status: 500 });
        }
        try {
          const out = await probe({
            method: "youzan.shop.chain.descendent.organization.list",
            version: "1.0.1",
            shop,
            supabase: supabaseAdmin,
          });
          return Response.json({ ok: true, out });
        } catch (e: any) {
          return Response.json(
            {
              ok: false,
              message: e?.message ?? String(e),
              probe_summary: e?.probe_summary ?? null,
            },
            { status: 200 },
          );
        }
      },
    },
  },
});
