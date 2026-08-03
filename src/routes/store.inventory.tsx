import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Search } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { listSkus } from "@/lib/inventory.functions";
import { toThumbUrl } from "@/lib/image";
import { CATEGORY_LABEL } from "@/lib/inventory.helpers";

export const Route = createFileRoute("/store/inventory")({
  component: () => {
    const [q, setQ] = useState("");
    const fn = useServerFn(listSkus);
    const { data } = useQuery({
      queryKey: ["store-skus", q],
      queryFn: () => fn({ data: { search: q || undefined, limit: 100 } }),
      placeholderData: (p) => p,
    });
    return (
      <MobileShell title="本店库存" back="/store" base="/store">
        <div className="sticky top-0 z-10 border-b bg-background/95 p-3 backdrop-blur">
          <div className="flex h-11 items-center gap-2 rounded-xl border bg-muted/40 px-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="品名 / EPC / 备注"
              className="h-full flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        </div>
        <ul className="divide-y">
          {(data?.rows ?? []).map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
              {r.image_url ? (
                <img
                  src={toThumbUrl(r.image_url, 128) ?? r.image_url}
                  alt=""
                  className="h-12 w-12 flex-none rounded border object-cover"
                  loading="lazy"
                  width={48}
                  height={48}
                />
              ) : (
                <div className="h-12 w-12 flex-none rounded border bg-muted" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {CATEGORY_LABEL[r.category] ?? r.category} · ¥{Number(r.price_tier).toFixed(1)} · {r.inventory_policy === "unlimited" ? "库存不限" : `库存 ${r.stock_qty}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </MobileShell>
    );
  },
});
