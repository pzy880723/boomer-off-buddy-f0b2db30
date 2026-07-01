import { createFileRoute } from "@tanstack/react-router";
import { HANDHELD_CORS, authenticateDevice, ok } from "@/server/handheld-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/handheld/sku/search")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: HANDHELD_CORS }),
      GET: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if (!auth.ok) return auth.response;
        const url = new URL(request.url);
        const q = (url.searchParams.get("q") || "").trim();
        let query = supabaseAdmin
          .from("inv_skus")
          .select("id, sku_code, name, category, price_tier, stock_qty, image_url, image_paths")
          .order("updated_at", { ascending: false })
          .limit(20);
        if (q) query = query.or(`sku_code.ilike.%${q}%,name.ilike.%${q}%`);
        const { data, error } = await query;
        if (error) return ok({ items: [] });

        const rows = (data ?? []) as Array<{
          id: string;
          sku_code: string | null;
          name: string;
          category: string | null;
          price_tier: number;
          stock_qty: number;
          image_url: string | null;
          image_paths: string[] | null;
        }>;

        const { signSkuImagePaths } = await import("@/lib/sku-image-resolver.server");
        const paths: string[] = [];
        const idxs: { rowIndex: number; path: string }[] = [];
        rows.forEach((r, i) => {
          for (const p of r.image_paths ?? []) {
            if (!p) continue;
            paths.push(p);
            idxs.push({ rowIndex: i, path: p });
          }
        });
        const signed = await signSkuImagePaths(paths);
        const imagesByIdx = new Map<number, { storage_path: string; read_url: string }[]>();
        idxs.forEach((entry, k) => {
          const readUrl = signed[k];
          if (!readUrl) return;
          const list = imagesByIdx.get(entry.rowIndex) ?? [];
          list.push({ storage_path: entry.path, read_url: readUrl });
          imagesByIdx.set(entry.rowIndex, list);
        });

        const items = rows.map((r, i) => {
          const images = imagesByIdx.get(i) ?? [];
          return {
            id: r.id,
            sku_code: r.sku_code,
            name: r.name,
            category: r.category,
            price_tier: r.price_tier,
            stock_qty: r.stock_qty,
            image_url:
              images[0]?.read_url ??
              (r.image_url && /^https?:\/\//i.test(r.image_url) && !r.image_url.includes("token=")
                ? r.image_url
                : null),
            image_paths: r.image_paths ?? [],
            images,
          };
        });
        return ok({ items });
      },
    },
  },
});
