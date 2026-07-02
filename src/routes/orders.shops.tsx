import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import {
  Link2,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronRight,
  Package,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { listShopOrders } from "@/lib/youzan.functions";
import { YZ_STATUS_OPTIONS, yzStatusText } from "@/lib/youzan-status";

export const Route = createFileRoute("/orders/shops")({
  head: () => ({
    meta: [
      { title: "门店订单 · 订单管理" },
      { name: "description", content: "有赞各门店的销售订单" },
    ],
  }),
  component: ShopOrdersPage,
});

const cny = (n: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 2,
  }).format(n);

type RangeKey = "7" | "30" | "90" | "all";
const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "90", label: "近 90 天" },
  { value: "all", label: "全部" },
];

function ShopOrdersPage() {
  const fetchFn = useServerFn(listShopOrders);
  const q = useQuery({
    queryKey: ["shop-orders"],
    queryFn: () => fetchFn(),
    refetchInterval: 60_000,
  });

  const [shopFilter, setShopFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [rangeFilter, setRangeFilter] = useState<RangeKey>("30");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const PAGE_SIZE = 25;

  const shops = q.data?.shops ?? [];
  const orders = (q.data?.orders ?? []) as Array<Record<string, unknown>>;
  const shopNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shops) m.set(s.id, s.shop_name);
    return m;
  }, [shops]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const cutoff =
      rangeFilter === "all" ? 0 : now - Number(rangeFilter) * 24 * 60 * 60 * 1000;
    const kw = keyword.trim().toLowerCase();
    return orders.filter((o) => {
      if (shopFilter !== "all" && o.shop_id !== shopFilter) return false;
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (cutoff > 0) {
        const t = o.pay_time ? new Date(o.pay_time as string).getTime() : 0;
        if (!t || t < cutoff) return false;
      }
      if (kw) {
        const hay = [
          o.tid,
          o.buyer_nick,
          o.receiver_name,
          o.receiver_tel,
          o.item_titles,
          o.outer_transaction_no,
        ]
          .map((v) => (v == null ? "" : String(v).toLowerCase()))
          .join(" ");
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [orders, shopFilter, statusFilter, rangeFilter, keyword]);

  const totalAmount = useMemo(
    () =>
      filtered.reduce(
        (s, o) => s + Number((o.payment as number) ?? (o.total_fee as number) ?? 0),
        0,
      ),
    [filtered],
  );

  const totalItems = useMemo(
    () => filtered.reduce((s, o) => s + Number((o.item_count as number) ?? (o.num as number) ?? 0), 0),
    [filtered],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <PageHeader
        title="门店订单"
        description={`${filtered.length} / ${orders.length} 条 · ${shops.length} 家门店 · 合计 ${cny(totalAmount)} · ${totalItems} 件`}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/youzan">
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
                有赞对接
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => q.refetch()}
              disabled={q.isFetching}
            >
              <RefreshCw
                className={`mr-1.5 h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`}
              />
              刷新
            </Button>
          </div>
        }
      />

      {/* 筛选条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(1);
            }}
            placeholder="搜索 订单号/买家/收货人/商品"
            className="h-8 pl-7 w-[260px]"
          />
        </div>
        <Select
          value={shopFilter}
          onValueChange={(v) => {
            setShopFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-8 w-[200px]">
            <SelectValue placeholder="门店" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部门店</SelectItem>
            {shops.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.shop_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            {YZ_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={rangeFilter}
          onValueChange={(v) => {
            setRangeFilter(v as RangeKey);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-8 w-[120px]">
            <SelectValue placeholder="时间" />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 订单列表 */}
      {pageRows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            没有匹配的订单
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {pageRows.map((o) => {
            const id = o.id as string;
            const expanded = expandedId === id;
            return (
              <OrderRow
                key={id}
                row={o}
                expanded={expanded}
                onToggle={() => setExpandedId(expanded ? null : id)}
                shopName={
                  shopNameMap.get(o.shop_id as string) ??
                  `kdt_id ${o.kdt_id}`
                }
              />
            );
          })}
        </div>
      )}




      {/* 分页 */}
      {pageCount > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            第 {safePage} / {pageCount} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage === 1}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={safePage === pageCount}
          >
            下一页
          </Button>
        </div>
      )}
    </div>
  );
}

function OrderRow({
  row,
  expanded,
  onToggle,
  shopName,
}: {
  row: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
  shopName: string;
}) {
  const amount = Number(
    (row.payment as number) ?? (row.total_fee as number) ?? 0,
  );
  const status = (row.status_text as string) ?? yzStatusText(row.status as string | null);
  const payTime = row.pay_time
    ? new Date(row.pay_time as string).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  const txn = (row.outer_transaction_no as string) ?? "";

  const itemCount = Number(
    (row.item_count as number) ?? (row.num as number) ?? 0,
  );



  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden hover:shadow transition-shadow">
      {/* 顶部条：灰底 */}
      <button
        type="button"
        onClick={onToggle}
        className={`w-full flex items-start justify-between gap-3 px-4 py-2.5 text-left bg-muted/40 hover:bg-muted/60 transition-colors ${expanded ? "border-b" : ""}`}
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-semibold tracking-tight">
              #{row.tid as string}
            </span>
            <Badge variant="outline" className="text-[10px] h-5 bg-background">
              {status}
            </Badge>
            {txn && (
              <span className="text-[11px] font-mono text-muted-foreground">
                交易号 {txn}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {shopName}{itemCount > 0 ? ` · ${itemCount} 件` : ""}
          </div>

        </div>
        <div className="text-right shrink-0 flex items-start gap-2">
          <div>
            <div className="text-base font-semibold tabular-nums leading-tight">
              {cny(amount)}
            </div>
            <div className="text-[11px] font-mono text-muted-foreground tabular-nums">
              {payTime}
            </div>
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground mt-1" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground mt-1" />
          )}
        </div>
      </button>

      {/* 展开：明细 + 支付 */}
      {expanded && (
        <div className="border-t bg-muted/20 px-4 py-3">
          <OrderDetail row={row} />
        </div>
      )}

    </div>
  );
}


function OrderDetail({ row }: { row: Record<string, unknown> }) {
  const raw = row.raw as Record<string, unknown> | null;
  const fullOrder =
    (raw?.full_order_info as Record<string, unknown> | undefined) ?? {};
  const orders =
    (fullOrder.orders as Array<Record<string, unknown>> | undefined) ?? [];

  return (
    <div className="text-xs space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-medium text-foreground">商品明细</div>
        {row.post_fee != null && Number(row.post_fee) > 0 && (
          <div className="text-muted-foreground">
            运费 {cny(Number(row.post_fee))}
          </div>
        )}
      </div>
      <div className="space-y-1">
        {orders.length === 0 && (
          <div className="text-muted-foreground">无明细</div>
        )}
        {orders.map((o, i) => {
          const title = String(o.title ?? "");
          const num = Number(o.num ?? 0);
          const total = Number(o.total_fee ?? o.payment ?? 0);
          const sku = String(o.item_no ?? o.outer_item_id ?? "");
          return (
            <div
              key={i}
              className="flex items-center justify-between gap-3 py-1 border-b last:border-0"
            >
              <div className="min-w-0">
                <div className="truncate">{title || "—"}</div>
                {sku && (
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {sku}
                  </div>
                )}
              </div>
              <div className="text-right tabular-nums">
                <div>×{num}</div>
                <div className="text-muted-foreground">{cny(total)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>

  );
}

