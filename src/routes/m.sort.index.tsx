import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Boxes } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { listSortQueue } from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";

export const Route = createFileRoute("/m/sort/")({
  component: SortQueue,
});

function SortQueue() {
  const fn = useServerFn(listSortQueue);
  const { data, isLoading } = useQuery({ queryKey: ["sort-queue"], queryFn: () => fn() });
  return (
    <MobileShell title="分拣台">
      <div className="p-3">
        <div className="mb-2 text-xs text-muted-foreground">已签收待分拣 {data?.rows.length ?? 0} 个</div>
        <ul className="divide-y rounded-2xl border bg-card">
          {(data?.rows ?? []).map((r) => (
            <li key={r.id}>
              <Link
                to="/m/sort/$id"
                params={{ id: r.id }}
                className="flex items-center gap-3 px-3 py-3 active:bg-muted"
              >
                {r.item_image_url ? (
                  <img
                    src={toThumbUrl(r.item_image_url, 128) ?? r.item_image_url}
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
                  <div className="truncate text-sm font-medium">
                    {r.item_title_cn || r.item_title || "(未命名)"}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {r.tracking_no || r.source_order_no} · {r.japan_parcel_items?.length ?? 0} 件子商品
                  </div>
                </div>
                <Boxes className="h-4 w-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
          {!isLoading && (data?.rows ?? []).length === 0 ? (
            <li className="px-6 py-10 text-center text-sm text-muted-foreground">暂无待分拣包裹</li>
          ) : null}
        </ul>
      </div>
    </MobileShell>
  );
}
