import { lazy, Suspense, useEffect, useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Plus,
  Search,
  Trash2,
  Pencil,
  CheckCircle2,
  Package,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  AlertTriangle,
  RotateCcw,
  RefreshCw,
  Flag,
  Copy,
  Calculator,
  PackageCheck,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import {
  simplifyStatus,
  getDisplayTitle,
  computeParcelItemLanded,
  computePiecePrice,
} from "@/lib/japan-parcel.helpers";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  listJapanParcels,
  updateJapanParcelStatus,
  updateJapanParcel,
  deleteJapanParcel,
  bulkDeleteJapanParcels,
  bulkUpdateJapanParcelStatus,
  getJapanParcelCounts,
  setJapanParcelProblem,
  restoreJapanParcels,
  purgeJapanParcels,
  type ParcelTab,
} from "@/lib/japan-parcel.functions";
import { useDebounced } from "@/hooks/use-debounced";
import type { ParcelCardData, ParcelCardItem } from "@/components/japan-parcel/parcel-card-dialog";
import { ItemsHoverPreview } from "@/components/japan-parcel/items-hover-preview";
import { CurrencyToggle } from "@/components/japan-parcel/currency-toggle";
import { ViewModeToggle } from "@/components/japan-parcel/view-mode-toggle";
import { useCurrencyDisplay } from "@/hooks/use-currency-display";
import { useParcelViewMode } from "@/hooks/use-parcel-view-mode";
import { cn } from "@/lib/utils";
import { ClickableThumb } from "@/components/japan-parcel/image-lightbox";

const ParcelCardDialog = lazy(() =>
  import("@/components/japan-parcel/parcel-card-dialog").then((m) => ({
    default: m.ParcelCardDialog,
  })),
);
const PackPriceCalculatorDialog = lazy(() =>
  import("@/components/japan-parcel/pack-price-calculator-dialog").then((m) => ({
    default: m.PackPriceCalculatorDialog,
  })),
);
const ItemCardDialog = lazy(() =>
  import("@/components/japan-parcel/item-card-dialog").then((m) => ({
    default: m.ItemCardDialog,
  })),
);

type SortField = "intl_pay_at" | "grand_total_cny" | "created_at";
type SortDir = "asc" | "desc";
type SortState = { field: SortField; dir: SortDir };

const buildListKey = (tab: ParcelTab, search: string, sort: SortState) =>
  ["jp-parcels", { tab, search, sort }] as const;

const listOptions = (tab: ParcelTab, search: string, sort: SortState) => ({
  queryKey: buildListKey(tab, search, sort),
  queryFn: () => listJapanParcels({ data: { tab, search, sort } }),
  staleTime: 60_000,
  refetchOnWindowFocus: false,
});


export const Route = createFileRoute("/purchase/japan-parcel/")({
  head: () => ({
    meta: [
      { title: "日本小包 · BOOMER OFF" },
      { name: "description", content: "Meruki / Yahoo / Mercari 小包裹订单管理" },
    ],
  }),
  component: JapanParcelList,
});

type ItemRow = {
  id: string;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
  item_total_jpy: number | null;
  item_total_cny: number | null;
  weight_g?: number | null;
  unit_price_jpy?: number | null;
  quantity?: number | null;
  sub_order_no?: string | null;
  position?: number | null;
  tariff_category?: string | null;
  tariff_rate?: number | null;
  pack_pieces?: number | null;
  pack_pieces_source?: string | null;
  pack_unit_note?: string | null;
};

type ParcelRow = ParcelCardData & {
  source: string;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
  total_jpy: number | null;
  tariff_cny?: number | null;
  intl_pay_at?: string | null;
  is_problem?: boolean | null;
  deleted_at?: string | null;
  japan_parcel_items?: ItemRow[];
};



function JapanParcelList() {
  const qc = useQueryClient();
  const router = useRouter();
  const updateStatus = useServerFn(updateJapanParcelStatus);
  const updateParcel = useServerFn(updateJapanParcel);
  const delOne = useServerFn(deleteJapanParcel);
  const delMany = useServerFn(bulkDeleteJapanParcels);
  const bulkSetStatus = useServerFn(bulkUpdateJapanParcelStatus);
  const setProblemFn = useServerFn(setJapanParcelProblem);
  const restoreFn = useServerFn(restoreJapanParcels);
  const purgeFn = useServerFn(purgeJapanParcels);

  const [tab, setTab] = useState<ParcelTab>("purchased");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<"overview" | "edit">("overview");
  const [packCalc, setPackCalc] = useState<{ item: ItemRow; landedCny: number | null } | null>(null);
  const [itemCard, setItemCard] = useState<{ item: ItemRow; parcelId: string } | null>(null);
  const [currency] = useCurrencyDisplay();
  const [viewMode, setViewMode] = useParcelViewMode();
  const [sort, setSort] = useState<SortState>({ field: "intl_pay_at", dir: "desc" });
  const debouncedSearch = useDebounced(search, 300);

  // debounce 自动同步到 submittedSearch
  useEffect(() => {
    setSubmittedSearch(debouncedSearch);
  }, [debouncedSearch]);

  // 搜索时自动切到「商品」视图，便于直接看到匹配商品
  useEffect(() => {
    if (submittedSearch && viewMode !== "item") setViewMode("item");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submittedSearch]);

  const list = useQuery({
    ...listOptions(tab, submittedSearch, sort),
    placeholderData: (previousData) => previousData,
  });

  const countsQ = useQuery({
    queryKey: ["jp-parcels-counts"],
    queryFn: () => getJapanParcelCounts(),
    staleTime: 30_000,
  });
  const counts = countsQ.data ?? { all: 0, purchased: 0, delivered: 0, problem: 0, trash: 0 };

  const rows = (list.data?.rows ?? []) as unknown as ParcelRow[];
  const isTrash = tab === "trash";

  const toggleSort = (field: SortField) =>
    setSort((s) =>
      s.field === field ? { field, dir: s.dir === "desc" ? "asc" : "desc" } : { field, dir: "desc" },
    );

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["jp-parcels"] });
    qc.invalidateQueries({ queryKey: ["jp-parcels-counts"] });
  };
  const fetchingCount =
    useIsFetching({ queryKey: ["jp-parcels"] }) +
    useIsFetching({ queryKey: ["jp-parcels-counts"] });

  const switchTab = (next: ParcelTab) => {
    if (next === tab) return;
    setSelected(new Set());
    setTab(next);
  };

  const statusMut = useMutation({
    mutationFn: async (v: { id: string; status: "purchased" | "delivered" }) => {
      if (v.status === "delivered") {
        return updateParcel({
          data: { id: v.id, status: "delivered", received_at: new Date().toISOString() } as never,
        });
      }
      return updateStatus({ data: { id: v.id, status: v.status } });
    },
    onSuccess: (_d, v) => {
      toast.success(v.status === "delivered" ? "已标记为已签收" : "已恢复为已采购");
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const problemMut = useMutation({
    mutationFn: (v: { id: string; is_problem: boolean }) => setProblemFn({ data: v }),
    onSuccess: (_d, v) => {
      toast.success(v.is_problem ? "已标记为问题包裹" : "已取消问题标记");
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));

  const delMut = useMutation({
    mutationFn: (id: string) => delOne({ data: { id } }),
    onSuccess: () => {
      toast.success("已移入回收站");
      setSelected(new Set());
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const bulkMut = useMutation({
    mutationFn: (ids: string[]) => delMany({ data: { ids } }),
    onSuccess: (r) => {
      toast.success(`已将 ${r.count} 条移入回收站`);
      setSelected(new Set());
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const signMut = useMutation({
    mutationFn: (ids: string[]) => bulkSetStatus({ data: { ids, status: "delivered" } }),
    onSuccess: (r) => {
      toast.success(`已签收 ${r.count} 条`);
      setSelected(new Set());
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const restoreMut = useMutation({
    mutationFn: (ids: string[]) => restoreFn({ data: { ids } }),
    onSuccess: (r) => {
      toast.success(`已还原 ${r.count} 条`);
      setSelected(new Set());
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const purgeMut = useMutation({
    mutationFn: (ids: string[]) => purgeFn({ data: { ids } }),
    onSuccess: (r) => {
      toast.success(`已彻底删除 ${r.count} 条`);
      setSelected(new Set());
      invalidateAll();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const openParcel = rows.find((r) => r.id === openCardId) ?? null;

  const TABS: { value: ParcelTab; label: string; count?: number; showBadge?: boolean }[] = [
    { value: "all", label: "全部", count: counts.all },
    { value: "purchased", label: "已采购", count: counts.purchased, showBadge: true },
    { value: "delivered", label: "已签收", count: counts.delivered },
    { value: "problem", label: "问题包裹", count: counts.problem, showBadge: true },
    { value: "trash", label: "回收站", count: counts.trash },
  ];

  return (
    <div>
      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <div className="relative max-w-sm flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索订单号 / 物流号 / 商品名称（支持中文）"
              className="h-9 pl-8"
            />
          </div>

          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">展示</span>
              <ViewModeToggle />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">币种</span>
              <CurrencyToggle />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => invalidateAll()}
              disabled={fetchingCount > 0}
              title="刷新列表"
            >
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", fetchingCount > 0 && "animate-spin")} />
              刷新
            </Button>
            <Button asChild size="sm" className="bg-gradient-brand hover:opacity-90">
              <Link
                to="/purchase/japan-parcel/new"
                onMouseEnter={() => router.preloadRoute({ to: "/purchase/japan-parcel/new" })}
                onPointerDown={() => router.preloadRoute({ to: "/purchase/japan-parcel/new" })}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                新建包裹
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="mb-3 flex items-center gap-1 border-b">
        {TABS.map((t) => {
          const active = tab === t.value;
          const showBadge = t.showBadge && (t.count ?? 0) > 0;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => switchTab(t.value)}
              className={cn(
                "relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <span>{t.label}</span>
              {!showBadge && t.count != null && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t.count}
                </span>
              )}
              {showBadge && (
                <span
                  className={cn(
                    "ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                    t.value === "problem"
                      ? "bg-destructive text-destructive-foreground"
                      : "bg-primary text-primary-foreground",
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span>已选择 {selected.size} 条</span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              取消
            </Button>
            {isTrash ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restoreMut.isPending}
                  onClick={() => restoreMut.mutate(Array.from(selected))}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  批量还原
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={purgeMut.isPending}
                  onClick={() => {
                    if (confirm(`确认彻底删除选中的 ${selected.size} 条订单？此操作不可恢复。`))
                      purgeMut.mutate(Array.from(selected));
                  }}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  彻底删除
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={signMut.isPending}
                  onClick={() => {
                    if (confirm(`确认将选中的 ${selected.size} 条包裹标记为已签收？`))
                      signMut.mutate(Array.from(selected));
                  }}
                >
                  <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
                  批量签收
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={bulkMut.isPending}
                  onClick={() => {
                    if (confirm(`确认删除选中的 ${selected.size} 条订单？将移入回收站。`))
                      bulkMut.mutate(Array.from(selected));
                  }}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  批量删除
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {list.isLoading && rows.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">正在加载小包裹列表…</div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="暂无小包裹订单"
              description="可以单条 AI 识图，或手动新建。"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b bg-muted/30 hover:bg-muted/30">
                  {viewMode === "parcel" && (
                    <TableHead className="w-[36px] text-center">
                      <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="全选" />
                    </TableHead>
                  )}
                  <TableHead className="w-[64px] text-center text-[11px] uppercase tracking-wider text-muted-foreground">图</TableHead>
                  <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {viewMode === "parcel" ? "订单 / 标题" : "商品 / 所属包裹"}
                  </TableHead>
                  {viewMode === "parcel" ? (
                    <TableHead className="w-[60px] text-center text-[11px] uppercase tracking-wider text-muted-foreground">子单</TableHead>
                  ) : (
                    <TableHead className="w-[80px] text-center text-[11px] uppercase tracking-wider text-muted-foreground">数量</TableHead>
                  )}
                  <TableHead className="text-center">
                    <SortHeader
                      label="合计"
                      active={sort.field === "grand_total_cny"}
                      dir={sort.dir}
                      onClick={() => toggleSort("grand_total_cny")}
                    />
                  </TableHead>
                  <TableHead className="text-center">
                    <SortHeader
                      label="支付时间"
                      title="国际物流支付时间"
                      active={sort.field === "intl_pay_at"}
                      dir={sort.dir}
                      onClick={() => toggleSort("intl_pay_at")}
                    />
                  </TableHead>
                  <TableHead className="w-[110px] text-center text-[11px] uppercase tracking-wider text-muted-foreground">状态</TableHead>
                  <TableHead className="w-[160px] text-center text-[11px] uppercase tracking-wider text-muted-foreground">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.flatMap((r) => {
                  const items = (r.japan_parcel_items ?? []) as ItemRow[];
                  const subCount = items.length;
                  const subSumJpy = items.reduce((s, it) => s + (Number(it.item_total_jpy) || 0), 0);
                  const fallbackJpy = subSumJpy + (Number(r.intl_total_jpy) || 0);
                  const totalJpy =
                    Number(r.grand_total_jpy) || fallbackJpy || Number(r.total_jpy) || 0;
                  const rate = Number(r.intl_exchange_rate) || 0;
                  const tariffCny =
                    Number(r.tariff_cny) ||
                    (rate > 0 ? (Number(r.tariff_jpy) || 0) * rate : 0);
                  const fallbackCny = rate > 0 ? totalJpy * rate + tariffCny : 0;
                  const totalCny = Number(r.grand_total_cny) || fallbackCny || 0;
                  const title = getDisplayTitle(r, items);
                  const simple = simplifyStatus(r.status);
                  const payAt = r.intl_pay_at ?? r.purchased_at ?? null;
                  const payAtDisplay = payAt
                    ? new Date(payAt).toLocaleString("zh-CN", {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—";
                  const openCard = (tab: "overview" | "edit" = "overview") => {
                    void import("@/components/japan-parcel/parcel-card-dialog");
                    setOpenTab(tab);
                    setOpenCardId(r.id);
                  };

                  if (viewMode === "item") {
                    const sortedItems = [...items].sort(
                      (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0),
                    );
                    const landedMap = computeParcelItemLanded(
                      { intl_total_jpy: r.intl_total_jpy, intl_exchange_rate: r.intl_exchange_rate },
                      sortedItems,
                    );
                    const displayItems: (ItemRow | null)[] = sortedItems.length ? sortedItems : [null];
                    return displayItems.map((it, idx) => {
                      const landed = it ? landedMap.get(it.id) : null;
                      return (
                        <TableRow
                          key={`${r.id}-${it?.id ?? "empty"}-${idx}`}
                          className="group cursor-pointer transition-colors hover:bg-muted/40"
                          onClick={() => it && setItemCard({ item: it, parcelId: r.id })}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            {it?.item_image_url ? (
                              <ClickableThumb
                                src={it.item_image_url}
                                thumbWidth={160}
                                className="h-12 w-12 rounded object-cover"
                              />
                            ) : (
                              <div className="h-12 w-12 rounded bg-muted" />
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="line-clamp-1 text-sm font-medium">
                              {it?.item_title_cn || it?.item_title || title}
                            </div>
                            {it?.item_title_cn && it?.item_title && (
                              <div className="line-clamp-1 text-[11px] text-muted-foreground">
                                {it.item_title}
                              </div>
                            )}
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <span>包裹 {r.tracking_no || r.source_order_no || r.id.slice(0, 8)}</span>
                              {it?.tariff_category && (
                                <span className="rounded bg-muted px-1 py-px text-[10px]">
                                  {it.tariff_category}
                                  {it.tariff_rate ? ` ${(Number(it.tariff_rate) * 100).toFixed(0)}%` : ""}
                                </span>
                              )}
                              {it?.pack_pieces && it.pack_pieces > 1 && (() => {
                                const { pieceCny, pieceJpy } = computePiecePrice(
                                  it.item_total_jpy,
                                  landed?.landedCny ?? null,
                                  it.pack_pieces,
                                );
                                const u = it.pack_unit_note || "个";
                                const tag =
                                  it.pack_pieces_source === "title"
                                    ? "📝"
                                    : it.pack_pieces_source === "image"
                                      ? "🖼️"
                                      : "";
                                return (
                                  <span className="rounded bg-primary/10 px-1 py-px text-[10px] text-primary">
                                    拆 {it.pack_pieces}{u} ·{" "}
                                    {pieceCny != null
                                      ? `RMB ${pieceCny.toFixed(2)}/${u}`
                                      : pieceJpy != null
                                        ? `JPY ${pieceJpy.toFixed(0)}/${u}`
                                        : "—"}
                                    {tag && <span className="ml-0.5">{tag}</span>}
                                  </span>
                                );
                              })()}
                            </div>
                          </TableCell>
                          <TableCell className="text-center text-sm tabular-nums">
                            {it?.quantity ?? "—"}
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            {landed && landed.landedCny != null ? (
                              <HoverCard openDelay={150} closeDelay={80}>
                                <HoverCardTrigger asChild>
                                  <button
                                    type="button"
                                    className="font-mono text-sm font-semibold tabular-nums hover:underline decoration-dotted underline-offset-4"
                                  >
                                    RMB {Math.round(landed.landedCny).toLocaleString()}
                                  </button>
                                </HoverCardTrigger>
                                <HoverCardContent side="left" align="start" className="w-60 p-3 text-xs">
                                  <div className="space-y-1.5 font-mono tabular-nums">
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">商品金额</span>
                                      <span>RMB {Math.round(landed.itemCny ?? 0).toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">均摊运费（按重量）</span>
                                      <span>RMB {Math.round(landed.freightShareCny ?? 0).toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">
                                        关税
                                        {it?.tariff_rate
                                          ? `(${(Number(it.tariff_rate) * 100).toFixed(0)}%)`
                                          : ""}
                                      </span>
                                      {it?.tariff_rate ? (
                                        <span>RMB {Math.round(landed.tariffCny ?? 0).toLocaleString()}</span>
                                      ) : (
                                        <span className="text-muted-foreground">未设置</span>
                                      )}
                                    </div>
                                    <div className="border-t pt-1.5 mt-1.5 flex justify-between font-semibold">
                                      <span>到手价</span>
                                      <span>RMB {Math.round(landed.landedCny).toLocaleString()}</span>
                                    </div>
                                  </div>
                                </HoverCardContent>
                              </HoverCard>
                            ) : landed ? (
                              <span className="text-xs text-muted-foreground">缺少汇率</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center text-xs text-muted-foreground tabular-nums">
                            {payAtDisplay}
                          </TableCell>
                          <TableCell className="text-center">
                            {simple === "delivered" ? (
                              <Badge className="gap-1 bg-success/15 text-success hover:bg-success/20 border-0">
                                <CheckCircle2 className="h-3 w-3" /> 已签收
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="gap-1">
                                <Package className="h-3 w-3" /> 已采购
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1">
                              {it && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  title="拆包单价计算"
                                  onClick={() =>
                                    setPackCalc({ item: it, landedCny: landed?.landedCny ?? null })
                                  }
                                >
                                  <Calculator className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-[11px]"
                                onClick={() => openCard("overview")}
                              >
                                打开包裹
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    });
                  }

                  return [
                    <TableRow
                      key={r.id}
                      data-state={selected.has(r.id) ? "selected" : undefined}
                      className="group cursor-pointer transition-colors hover:bg-muted/40"
                      onClick={() => openCard("overview")}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selected.has(r.id)}
                          onCheckedChange={() => toggleSelect(r.id)}
                          aria-label="选中此行"
                        />
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <ItemsHoverPreview
                          items={items.map((it) => ({
                            id: it.id,
                            item_title: it.item_title,
                            item_title_cn: it.item_title_cn,
                            item_image_url: it.item_image_url,
                          }))}
                          onClick={() => openCard("overview")}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="line-clamp-1 text-sm font-medium">{title}</div>
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          {r.tracking_no ? (
                            <>
                              <span className="font-mono">{r.tracking_no}</span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(r.tracking_no!);
                                  toast.success("已复制物流单号");
                                }}
                                className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted"
                                aria-label="复制物流单号"
                                title="复制"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            </>
                          ) : (
                            <span>—</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center text-sm">
                        {subCount > 0 ? (
                          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums">
                            {subCount}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        {rate > 0 && totalCny > 0 ? (
                          <HoverCard openDelay={150} closeDelay={80}>
                            <HoverCardTrigger asChild>
                              <button
                                type="button"
                                className="font-mono text-sm font-semibold tabular-nums hover:underline decoration-dotted underline-offset-4"
                              >
                                RMB {Math.round(totalCny).toLocaleString()}
                              </button>
                            </HoverCardTrigger>
                            <HoverCardContent side="left" align="start" className="w-60 p-3 text-xs">
                              <div className="space-y-1.5 font-mono tabular-nums">
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">商品合计</span>
                                  <span>RMB {Math.round(subSumJpy * rate).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">国际运费</span>
                                  <span>RMB {Math.round((Number(r.intl_total_jpy) || 0) * rate).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">关税</span>
                                  {tariffCny > 0 ? (
                                    <span>RMB {Math.round(tariffCny).toLocaleString()}</span>
                                  ) : (
                                    <span className="text-muted-foreground">未设置</span>
                                  )}
                                </div>
                                <div className="border-t pt-1.5 mt-1.5 flex justify-between font-semibold">
                                  <span>到手价</span>
                                  <span>RMB {Math.round(totalCny).toLocaleString()}</span>
                                </div>
                              </div>
                            </HoverCardContent>
                          </HoverCard>
                        ) : totalJpy > 0 ? (
                          <span className="text-xs text-muted-foreground">缺少汇率</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center text-xs text-muted-foreground tabular-nums">
                        {payAtDisplay}
                      </TableCell>
                      <TableCell>
                        {simple === "delivered" ? (
                          <Badge className="gap-1 bg-success/15 text-success hover:bg-success/20 border-0">
                            <CheckCircle2 className="h-3 w-3" /> 已签收
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <Package className="h-3 w-3" /> 已采购
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-center gap-0.5">
                          {isTrash ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-[11px]"
                                disabled={restoreMut.isPending}
                                onClick={() => restoreMut.mutate([r.id])}
                                title="还原"
                              >
                                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                还原
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                disabled={purgeMut.isPending}
                                onClick={() => {
                                  if (confirm("确认彻底删除此订单？此操作不可恢复。"))
                                    purgeMut.mutate([r.id]);
                                }}
                                aria-label="彻底删除"
                                title="彻底删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          ) : (
                            <>
                              {simple === "delivered" ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                                  disabled={statusMut.isPending}
                                  onClick={() => statusMut.mutate({ id: r.id, status: "purchased" })}
                                  title="撤销签收"
                                >
                                  撤销签收
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-8 px-2 text-[11px] font-medium text-success hover:bg-success/10 hover:text-success"
                                  disabled={statusMut.isPending}
                                  onClick={() => statusMut.mutate({ id: r.id, status: "delivered" })}
                                  title="确认签收"
                                >
                                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                                  确认签收
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "h-8 w-8",
                                  r.is_problem
                                    ? "text-destructive hover:text-destructive"
                                    : "text-muted-foreground hover:text-destructive",
                                )}
                                disabled={problemMut.isPending}
                                onClick={() =>
                                  problemMut.mutate({ id: r.id, is_problem: !r.is_problem })
                                }
                                aria-label={r.is_problem ? "取消问题标记" : "标记为问题包裹"}
                                title={r.is_problem ? "取消问题标记" : "标记为问题包裹"}
                              >
                                {r.is_problem ? (
                                  <AlertTriangle className="h-3.5 w-3.5" />
                                ) : (
                                  <Flag className="h-3.5 w-3.5" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                aria-label="编辑"
                                title="编辑"
                                onClick={() => openCard("edit")}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                disabled={delMut.isPending}
                                onClick={() => {
                                  if (confirm("确认删除此订单？将移入回收站。")) delMut.mutate(r.id);
                                }}
                                aria-label="删除"
                                title="删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>,
                  ];
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {openCardId && (
        <Suspense fallback={null}>
          <ParcelCardDialog
            open={!!openCardId}
            onOpenChange={(o) => !o && setOpenCardId(null)}
            parcel={openParcel}
            items={(openParcel?.japan_parcel_items ?? []) as ParcelCardItem[]}
            defaultTab={openTab}
          />
        </Suspense>
      )}

      {packCalc && (
        <Suspense fallback={null}>
          <PackPriceCalculatorDialog
            open={!!packCalc}
            onOpenChange={(o) => !o && setPackCalc(null)}
            item={packCalc.item}
            landedCny={packCalc.landedCny}
          />
        </Suspense>
      )}

      {itemCard && (() => {
        const parcelRow = rows.find((p) => p.id === itemCard.parcelId) ?? null;
        const siblings = (parcelRow?.japan_parcel_items ?? []) as ItemRow[];
        return (
          <Suspense fallback={null}>
            <ItemCardDialog
              open={!!itemCard}
              onOpenChange={(o) => !o && setItemCard(null)}
              item={itemCard.item}
              parcel={
                parcelRow
                  ? {
                      id: parcelRow.id,
                      source_order_no: parcelRow.source_order_no,
                      tracking_no: parcelRow.tracking_no,
                      intl_total_jpy: parcelRow.intl_total_jpy ?? null,
                      intl_exchange_rate: parcelRow.intl_exchange_rate ?? null,
                    }
                  : null
              }
              siblings={siblings}
              onOpenParcel={() => {
                const pid = itemCard.parcelId;
                setItemCard(null);
                void import("@/components/japan-parcel/parcel-card-dialog");
                setOpenTab("overview");
                setOpenCardId(pid);
              }}
            />
          </Suspense>
        );
      })()}
    </div>
  );
}

function SortHeader({
  label,
  title,
  active,
  dir,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  const Icon = active ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 text-[11px] uppercase tracking-wider transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <Icon className={cn("h-3 w-3", !active && "opacity-40")} />
    </button>
  );
}

