import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Search, AlertTriangle } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { searchParcels } from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";
import { useParcelViewMode } from "@/hooks/use-parcel-view-mode";

export const Route = createFileRoute("/m/parcels")({
  component: ParcelsSearch,
});

type Bucket = "pending" | "received";

function fmtDate(s: string | null | undefined) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(+d)) return null;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}-${day}`;
}
function fmtDateTime(s: string | null | undefined) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(+d)) return null;
  return `${fmtDate(s)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ParcelsSearch() {
  const [bucket, setBucket] = useState<Bucket>("pending");
  const [q, setQ] = useState("");
  const [mode, setMode] = useParcelViewMode();
  const fetchSearch = useServerFn(searchParcels);

  // 输入搜索词时自动切到「商品」视图，和 PC 端一致
  useEffect(() => {
    if (q.trim() && mode !== "item") setMode("item");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const { data, isLoading } = useQuery({
    queryKey: ["mobile-parcels", bucket, q, mode],
    queryFn: () => fetchSearch({ data: { q: q || undefined, bucket, mode, limit: 30 } }),
    placeholderData: (prev) => prev,
  });

  return (
    <MobileShell title="包裹">
      <div className="sticky top-0 z-10 space-y-2 border-b bg-background/95 p-3 backdrop-blur">
        <div className="flex h-10 items-center gap-2 rounded-xl border bg-muted/40 px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === "item" ? "搜索商品名 / 子单号" : "单号 / 订单号 / 商品名 / 卖家"}
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-xl border bg-muted/30 p-1">
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
              className={`rounded-lg py-2 text-xs font-medium transition-colors ${
                bucket === t.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1 rounded-xl border bg-muted/30 p-1">
          {(
            [
              { v: "parcel" as const, l: "按包裹" },
              { v: "item" as const, l: "按商品" },
            ]
          ).map((t) => (
            <button
              key={t.v}
              type="button"
              onClick={() => setMode(t.v)}
              className={`rounded-lg py-2 text-xs font-medium transition-colors ${
                mode === t.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>
      </div>

      {mode === "item" ? (
        <ul className="divide-y">
          {(data?.items ?? []).map((it) => {
            const thumb = toThumbUrl(it.item_image_url, 160);
            const name = it.item_title_cn || it.item_title || "(未填写商品名)";
            const orderNo = it.tracking_no || it.source_order_no || "无单号";
            const unit = it.unit_price_jpy != null ? Number(it.unit_price_jpy) : null;
            const qty = it.quantity ?? 1;
            const subCny = it.item_total_cny != null ? Number(it.item_total_cny) : null;
            const receivedAt = fmtDateTime(it.received_at);
            return (
              <li key={it.id}>
                <Link
                  to="/m/receive/$id"
                  params={{ id: it.parcel_id }}
                  className="flex items-start gap-3 px-3 py-3 active:bg-muted"
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="h-20 w-20 flex-none rounded-lg border object-cover"
                      loading="lazy"
                      decoding="async"
                      width={80}
                      height={80}
                    />
                  ) : (
                    <div className="h-20 w-20 flex-none rounded-lg border bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {orderNo}
                      </span>
                      {it.is_problem ? (
                        <AlertTriangle className="h-3.5 w-3.5 flex-none text-destructive" />
                      ) : null}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-sm font-medium">{name}</div>
                    <div className="mt-1 flex items-baseline gap-2 text-[11px] text-muted-foreground">
                      {unit != null ? (
                        <span className="text-sm font-semibold text-foreground">
                          ¥{unit.toLocaleString("ja-JP")}
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground">/件</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">无单价</span>
                      )}
                      <span>× {qty}</span>
                      {subCny != null ? <span>≈ ¥{subCny.toFixed(2)}</span> : null}
                    </div>
                    {bucket === "received" && receivedAt ? (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        签收于 {receivedAt}
                      </div>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
          {!isLoading && (data?.items ?? []).length === 0 ? (
            <li className="px-6 py-12 text-center text-sm text-muted-foreground">
              {q ? "没有匹配的商品" : bucket === "pending" ? "暂无待签收商品" : "暂无已签收商品"}
            </li>
          ) : null}
        </ul>
      ) : (
        <ul className="divide-y">
          {(data?.rows ?? []).map((r) => {
            const thumb = toThumbUrl(r.item_image_url, 160);
            const orderNo = r.tracking_no || r.source_order_no || "无单号";
            const purchasedAt = fmtDate(r.intl_pay_at ?? r.created_at);
            const receivedAt = fmtDateTime(r.received_at);
            const count = (r as { item_count?: number }).item_count ?? 0;
            const firstName =
              (r as { first_item_name?: string }).first_item_name ||
              r.item_title_cn ||
              r.item_title ||
              "";
            const head = firstName ? (firstName.length > 14 ? firstName.slice(0, 14) + "…" : firstName) : "";
            const title = !firstName
              ? "(未填写商品名)"
              : count > 1
                ? `${head} 等 ${count} 件商品`
                : firstName;
            return (
              <li key={r.id}>
                <Link
                  to="/m/receive/$id"
                  params={{ id: r.id }}
                  className="flex items-start gap-3 px-3 py-3 active:bg-muted"
                >
                  {thumb ? (
                    <img
                      src={thumb}
                      alt=""
                      className="h-20 w-20 flex-none rounded-lg border object-cover"
                      loading="lazy"
                      decoding="async"
                      width={80}
                      height={80}
                    />
                  ) : (
                    <div className="h-20 w-20 flex-none rounded-lg border bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {orderNo}
                      </span>
                      {r.is_problem ? (
                        <AlertTriangle className="h-3.5 w-3.5 flex-none text-destructive" />
                      ) : null}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-sm font-medium">{title}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                      {r.grand_total_cny != null ? (
                        <span className="font-medium text-foreground">
                          ¥{Number(r.grand_total_cny).toFixed(2)}
                        </span>
                      ) : null}
                      {purchasedAt ? <span>购于 {purchasedAt}</span> : null}
                    </div>
                    {bucket === "received" && receivedAt ? (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        签收于 {receivedAt}
                      </div>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
          {!isLoading && (data?.rows ?? []).length === 0 ? (
            <li className="px-6 py-12 text-center text-sm text-muted-foreground">
              {q ? "没有匹配的包裹" : bucket === "pending" ? "暂无待签收包裹" : "暂无已签收包裹"}
            </li>
          ) : null}
        </ul>
      )}
    </MobileShell>
  );
}
