import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Search, AlertTriangle } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { searchParcels } from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";

export const Route = createFileRoute("/m/parcels")({
  component: ParcelsSearch,
});

const STATUS_LABEL: Record<string, string> = {
  purchased: "已支付",
  at_jp_warehouse: "日仓",
  shipping_intl: "国际运输",
  delivered: "已签收",
  completed: "已完成",
};

function ParcelsSearch() {
  const [q, setQ] = useState("");
  const fetchSearch = useServerFn(searchParcels);
  const { data, isLoading } = useQuery({
    queryKey: ["mobile-parcels", q],
    queryFn: () => fetchSearch({ data: { q: q || undefined, limit: 30 } }),
    placeholderData: (prev) => prev,
  });

  return (
    <MobileShell title="包裹搜索">
      <div className="sticky top-0 z-10 border-b bg-background/95 p-3 backdrop-blur">
        <div className="flex h-11 items-center gap-2 rounded-xl border bg-muted/40 px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="单号 / 订单号 / 商品名 / 卖家"
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
      </div>
      <ul className="divide-y">
        {(data?.rows ?? []).map((r) => {
          const thumb = toThumbUrl(r.item_image_url, 128);
          return (
            <li key={r.id}>
              <Link
                to="/m/receive/$id"
                params={{ id: r.id }}
                className="flex items-center gap-3 px-3 py-3 active:bg-muted"
              >
                {thumb ? (
                  <img
                    src={thumb}
                    alt=""
                    className="h-14 w-14 flex-none rounded-lg border object-cover"
                    loading="lazy"
                    decoding="async"
                    width={56}
                    height={56}
                  />
                ) : (
                  <div className="h-14 w-14 flex-none rounded-lg border bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {r.item_title_cn || r.item_title || "(未填写商品名)"}
                    </span>
                    {r.is_problem ? <AlertTriangle className="h-3.5 w-3.5 flex-none text-destructive" /> : null}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {r.tracking_no || r.source_order_no || "无单号"}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px]">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    {r.grand_total_cny != null ? (
                      <span className="text-muted-foreground">¥{Number(r.grand_total_cny).toFixed(2)}</span>
                    ) : null}
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
        {!isLoading && (data?.rows ?? []).length === 0 ? (
          <li className="px-6 py-12 text-center text-sm text-muted-foreground">
            {q ? "没有匹配的包裹" : "输入关键词搜索"}
          </li>
        ) : null}
      </ul>
    </MobileShell>
  );
}
