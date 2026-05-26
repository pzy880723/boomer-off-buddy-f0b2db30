import { createFileRoute, Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, AlertCircle, X, Package, ShoppingBag, Loader2 } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { searchParcels } from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";
import { useParcelViewMode } from "@/hooks/use-parcel-view-mode";
import { ItemDetailSheet, type ItemDetailValue } from "@/components/mobile/item-detail-sheet";

export const Route = createFileRoute("/m/parcels")({
  component: ParcelsSearch,
});

type Bucket = "pending" | "received";
const PAGE_SIZE = 30;

function fmtDate(s: string | null | undefined) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(+d)) return null;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDateTime(s: string | null | undefined) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(+d)) return null;
  return `${fmtDate(s)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function highlight(text: string, q: string) {
  const needle = q.trim();
  if (!needle) return text;
  const re = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-yellow-200/80 px-0.5 text-foreground dark:bg-yellow-500/40">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function ParcelsSearch() {
  const [bucket, setBucket] = useState<Bucket>("pending");
  const [q, setQ] = useState("");
  const [storedMode, setStoredMode] = useParcelViewMode();
  const mode = q.trim() ? "item" : storedMode;
  const [selected, setSelected] = useState<ItemDetailValue | null>(null);
  const fetchSearch = useServerFn(searchParcels);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const {
    data,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ["mobile-parcels", bucket, q, mode],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchSearch({
        data: { q: q || undefined, bucket, mode, limit: PAGE_SIZE, offset: pageParam as number },
      }),
    getNextPageParam: (last, all) =>
      last.hasMore ? all.reduce((s, p) => s + (mode === "item" ? p.items.length : p.rows.length), 0) : undefined,
  });

  const items = useMemo(
    () => (mode === "item" ? (data?.pages.flatMap((p) => p.items) ?? []) : []),
    [data, mode],
  );
  const rows = useMemo(
    () => (mode === "parcel" ? (data?.pages.flatMap((p) => p.rows) ?? []) : []),
    [data, mode],
  );

  // 无限滚动
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const showModeSwitch = !q.trim();

  return (
    <MobileShell title="包裹">
      <div className="sticky top-0 z-10 space-y-3 border-b border-border/60 bg-background/90 px-3 py-3 backdrop-blur">
        <div className="flex h-10 items-center gap-2 rounded-full bg-muted/70 px-4">
          <Search className="h-4 w-4 flex-none text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索商品名 / 子单号"
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {q ? (
            <button
              type="button"
              onClick={() => setQ("")}
              className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex h-8 items-center rounded-full bg-muted/60 p-0.5 text-xs">
            {(
              [
                { v: "pending" as const, l: "待签收" },
                { v: "received" as const, l: "已签收" },
              ]
            ).map((t) => (
              <button
                key={t.v}
                type="button"
                onClick={() => setBucket(t.v)}
                className={`h-7 rounded-full px-3 font-medium transition-colors ${
                  bucket === t.v
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                {t.l}
              </button>
            ))}
          </div>

          {showModeSwitch ? (
            <div className="inline-flex h-8 items-center rounded-full bg-muted/60 p-0.5 text-xs">
              {(
                [
                  { v: "item" as const, l: "商品", Icon: ShoppingBag },
                  { v: "parcel" as const, l: "包裹", Icon: Package },
                ]
              ).map((t) => (
                <button
                  key={t.v}
                  type="button"
                  onClick={() => setStoredMode(t.v)}
                  className={`flex h-7 items-center gap-1 rounded-full px-2.5 font-medium transition-colors ${
                    storedMode === t.v
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground"
                  }`}
                >
                  <t.Icon className="h-3.5 w-3.5" />
                  {t.l}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {mode === "item" ? (
        <ul className="px-3 py-1">
          {items.map((it) => {
            const thumb = toThumbUrl(it.item_image_url, 200);
            const name = it.item_title_cn || it.item_title || "(未填写商品名)";
            const qty = it.quantity ?? 1;
            const subCny = it.item_total_cny != null ? Number(it.item_total_cny) : null;
            const avgCny = subCny != null && qty > 0 ? subCny / qty : null;
            const receivedAt = fmtDateTime(it.received_at);
            const orderNo = it.sub_order_no || it.tracking_no || it.source_order_no;
            return (
              <li key={it.id} className="border-b border-border/40 last:border-0">
                <button
                  type="button"
                  onClick={() => setSelected(it as ItemDetailValue)}
                  className={`relative flex w-full items-start gap-3 py-3 text-left active:bg-muted/50 ${
                    it.is_problem ? "pl-2" : ""
                  }`}
                >
                  {it.is_problem ? (
                    <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-destructive" />
                  ) : null}
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="h-16 w-16 flex-none rounded-xl border border-border/40 object-cover"
                      loading="lazy"
                      decoding="async"
                      width={64}
                      height={64}
                    />
                  ) : (
                    <div className="flex h-16 w-16 flex-none items-center justify-center rounded-xl border border-border/40 bg-muted text-xl">
                      📦
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm font-medium leading-snug">{name}</div>
                    {orderNo ? (
                      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                        {orderNo}
                      </div>
                    ) : null}
                    {receivedAt ? (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        签收 {receivedAt}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-none flex-col items-end gap-0.5 pl-1">
                    {avgCny != null ? (
                      <span className="text-sm font-semibold tabular-nums">
                        ¥{avgCny.toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">无成本</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">× {qty} 件</span>
                    {it.is_problem ? (
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 text-destructive" />
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
          {!isLoading && items.length === 0 ? (
            <li className="px-6 py-16 text-center text-sm text-muted-foreground">
              {q ? "没有匹配的商品" : bucket === "pending" ? "暂无待签收商品" : "暂无已签收商品"}
            </li>
          ) : null}
        </ul>
      ) : (
        <ul className="px-3 py-1">
          {rows.map((r) => {
            const thumb = toThumbUrl(r.item_image_url, 200);
            const orderNo = r.tracking_no || r.source_order_no;
            const purchasedAt = fmtDate(r.intl_pay_at ?? r.created_at);
            const receivedAt = fmtDateTime(r.received_at);
            const count = (r as { item_count?: number }).item_count ?? 0;
            const totalQty = (r as { total_qty?: number }).total_qty ?? 0;
            const avgUnitCny = (r as { avg_unit_cny?: number | null }).avg_unit_cny;
            const unitCount = totalQty > 0 ? totalQty : count;
            const firstName =
              (r as { first_item_name?: string }).first_item_name ||
              r.item_title_cn ||
              r.item_title ||
              "";
            const head = firstName ? (firstName.length > 14 ? firstName.slice(0, 14) + "…" : firstName) : "";
            const title = !firstName
              ? "(未填写商品名)"
              : count > 1
                ? `${head} 等 ${count} 件`
                : firstName;
            return (
              <li key={r.id} className="border-b border-border/40 last:border-0">
                <Link
                  to="/m/receive/$id"
                  params={{ id: r.id }}
                  className={`relative flex items-start gap-3 py-3 active:bg-muted/50 ${
                    r.is_problem ? "pl-2" : ""
                  }`}
                >
                  {r.is_problem ? (
                    <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full bg-destructive" />
                  ) : null}
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="h-16 w-16 flex-none rounded-xl border border-border/40 object-cover"
                      loading="lazy"
                      decoding="async"
                      width={64}
                      height={64}
                    />
                  ) : (
                    <div className="flex h-16 w-16 flex-none items-center justify-center rounded-xl border border-border/40 bg-muted text-xl">
                      📦
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm font-medium leading-snug">{title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                      {orderNo ? <span className="truncate font-mono">{orderNo}</span> : null}
                      {purchasedAt ? <span>· 购 {purchasedAt}</span> : null}
                    </div>
                    {receivedAt ? (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        签收 {receivedAt}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-none flex-col items-end gap-0.5 pl-1">
                    {r.grand_total_cny != null ? (
                      <span className="text-sm font-semibold tabular-nums">
                        ¥{Number(r.grand_total_cny).toFixed(2)}
                      </span>
                    ) : null}
                    {avgUnitCny != null && unitCount > 0 ? (
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        ¥{avgUnitCny.toFixed(2)} × {unitCount} 件
                      </span>
                    ) : unitCount > 0 ? (
                      <span className="text-[10px] text-muted-foreground">{unitCount} 件</span>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
          {!isLoading && rows.length === 0 ? (
            <li className="px-6 py-16 text-center text-sm text-muted-foreground">
              {bucket === "pending" ? "暂无待签收包裹" : "暂无已签收包裹"}
            </li>
          ) : null}
        </ul>
      )}

      {/* 无限滚动哨兵 + 状态 */}
      <div ref={sentinelRef} className="flex items-center justify-center px-3 py-6 text-xs text-muted-foreground">
        {isLoading ? (
          <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载中…</span>
        ) : isFetchingNextPage ? (
          <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载更多…</span>
        ) : hasNextPage ? (
          <span>下滑加载更多</span>
        ) : (mode === "item" ? items.length : rows.length) > 0 ? (
          <span>— 没有更多了 —</span>
        ) : null}
      </div>

      <ItemDetailSheet
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        item={selected}
      />
    </MobileShell>
  );
}
