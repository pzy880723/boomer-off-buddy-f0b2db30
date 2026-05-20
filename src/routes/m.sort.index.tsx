import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Boxes, Search } from "lucide-react";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { listPendingSortItems } from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/m/sort/")({
  component: SortQueue,
});

function SortQueue() {
  const fn = useServerFn(listPendingSortItems);
  const [tab, setTab] = useState<"pending" | "sorted">("pending");
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["pending-sort-items", tab, q],
    queryFn: () => fn({ data: { status: tab, q: q.trim() || undefined } }),
  });
  const rows = data?.rows ?? [];

  return (
    <MobileShell title="分拣台">
      <div className="sticky top-0 z-10 space-y-2 border-b bg-background p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题 / 包裹单号"
            className="h-9 pl-8"
          />
        </div>
        <div className="flex gap-1 rounded-lg bg-muted p-1 text-xs">
          {[
            { v: "pending" as const, label: "待分拣" },
            { v: "sorted" as const, label: "已分拣" },
          ].map((t) => (
            <button
              key={t.v}
              onClick={() => setTab(t.v)}
              className={`flex-1 rounded-md py-1.5 ${
                tab === t.v ? "bg-background shadow font-medium" : "text-muted-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-3">
        <div className="mb-2 text-xs text-muted-foreground">
          {tab === "pending" ? "待分拣袋子" : "已分拣袋子"} {rows.length} 个
        </div>
        <ul className="divide-y rounded-2xl border bg-card">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                to="/m/sort/item/$itemId"
                params={{ itemId: r.id }}
                className="flex items-center gap-3 px-3 py-3 active:bg-muted"
              >
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
                  <div className="truncate text-sm font-medium">
                    {r.title || "(未命名)"}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {r.source_label || "—"}
                  </div>
                </div>
                <Boxes className="h-4 w-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
          {!isLoading && rows.length === 0 ? (
            <li className="px-6 py-10 text-center text-sm text-muted-foreground">
              {tab === "pending" ? "暂无待分拣袋子" : "暂无已分拣记录"}
            </li>
          ) : null}
        </ul>
      </div>
    </MobileShell>
  );
}
