import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Boxes, Search, RefreshCw, ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/data-table";
import { listShopProducts } from "@/lib/stock-transfer.functions";
import { syncYouzanItems } from "@/lib/youzan.functions";
import { TransferDialog } from "@/components/stores/transfer-dialog";

export const Route = createFileRoute("/shop-mgmt/products")({
  head: () => ({
    meta: [
      { title: "门店商品库 · 门店管理" },
      { name: "description", content: "查看各门店有赞商品并执行库存调拨" },
    ],
  }),
  component: ShopProductsPage,
});

type ShopRow = {
  id: string;
  shop_id: string;
  kdt_id: number;
  item_id: number;
  title: string | null;
  price: number | null;
  stock_qty: number;
  is_listed: boolean;
  pic_url: string | null;
  updated_at: string;
};
type OnSaleShop = {
  shop_id: string;
  shop_name: string;
  role: string;
  stock_qty: number;
  low: boolean;
};
type AggItem = {
  id: string;
  item_id: number;
  title: string | null;
  pic_url: string | null;
  price: number | null;
  total_stock: number;
  is_listed: boolean;
  status: "green" | "orange" | "red";
  on_sale_shops: OnSaleShop[];
  rows: ShopRow[];
};
type Shop = { id: string; shop_name: string; kdt_id: number; role: string };

const STATUS_META: Record<AggItem["status"], { label: string; cls: string }> = {
  green: { label: "在售", cls: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300" },
  orange: { label: "库存预警", cls: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300" },
  red: { label: "缺货/下架", cls: "bg-rose-500/15 text-rose-700 border-rose-500/30 dark:text-rose-300" },
};

function ShopProductsPage() {
  const qc = useQueryClient();
  const syncFn = useServerFn(syncYouzanItems);
  const [shopId, setShopId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [listed, setListed] = useState<string>("all");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { mode: "in"; targetItem: ShopRow; targetShop: Shop }
    | { mode: "out"; sourceItem: ShopRow; sourceShop: Shop }
    | null
  >(null);

  const { data, isLoading } = useQuery({
    queryKey: ["shop-products", shopId, search, listed],
    queryFn: () =>
      listShopProducts({
        data: {
          shop_id: shopId === "all" ? undefined : shopId,
          search: search || undefined,
          listed: listed === "all" ? undefined : listed === "listed",
        },
      }),
  });

  const items = (data?.items ?? []) as AggItem[];
  const shops = (data?.shops ?? []) as Shop[];

  const refresh = () => qc.invalidateQueries({ queryKey: ["shop-products"] });

  const handleSync = async (sid: string) => {
    setSyncing(sid);
    try {
      const r = await syncFn({ data: { shop_id: sid } });
      r.ok ? toast.success(r.message) : toast.error(r.message);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(null);
    }
  };

  // 操作按钮：当筛选了具体门店时启用（用该门店对应的 row）；否则禁用提示
  const pickRowForShop = (it: AggItem): ShopRow | null => {
    if (shopId === "all") return it.rows[0] ?? null;
    return it.rows.find((r) => r.shop_id === shopId) ?? null;
  };

  return (
    <div>
      <PageHeader
        title="门店商品库"
        description="商品来自总部统一同步；每行展示该 SPU 在哪些分店在售。"
        meta={
          <>
            <span>共 {items.length} 件商品</span>
            <span className="text-border">·</span>
            <span>{shops.length} 家门店</span>
          </>
        }
        actions={
          <>
            {shopId !== "all" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleSync(shopId)}
                disabled={syncing === shopId}
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing === shopId ? "animate-spin" : ""}`} />
                同步本店商品
              </Button>
            )}
          </>
        }
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Select value={shopId} onValueChange={setShopId}>
            <SelectTrigger className="h-9 w-[200px]">
              <SelectValue placeholder="选择门店" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部门店</SelectItem>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.shop_name}
                  {s.role === "hq" ? " · 总部" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={listed} onValueChange={setListed}>
            <SelectTrigger className="h-9 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="listed">在售</SelectItem>
              <SelectItem value="unlisted">已下架</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索商品标题"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
        </CardContent>
      </Card>

      {isLoading && (
        <p className="mb-2 text-xs text-muted-foreground">加载中…</p>
      )}
      <DataTable
        rowKey={(r: AggItem) => String(r.item_id)}
        data={items}
        columns={[
          {
            header: "商品",
            cell: (r: AggItem) => (
              <div className="flex items-center gap-2.5 min-w-0">
                {r.pic_url ? (
                  <img src={r.pic_url} alt="" className="h-9 w-9 rounded object-cover bg-muted" />
                ) : (
                  <div className="h-9 w-9 rounded bg-muted flex items-center justify-center text-muted-foreground">
                    <Boxes className="h-4 w-4" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm">{r.title || "(无标题)"}</p>
                  <p className="text-[10px] text-muted-foreground tabular-nums">spu {r.item_id}</p>
                </div>
              </div>
            ),
          },
          {
            header: "价格",
            cell: (r: AggItem) => <span className="tabular-nums">¥{Number(r.price ?? 0).toFixed(2)}</span>,
            className: "text-right",
          },
          {
            header: "总库存",
            cell: (r: AggItem) => (
              <span className={`tabular-nums font-medium ${r.total_stock === 0 ? "text-destructive" : ""}`}>
                {r.total_stock}
              </span>
            ),
            className: "text-right",
          },
          {
            header: "在售门店",
            cell: (r: AggItem) => {
              if (r.on_sale_shops.length === 0) {
                return <span className="text-xs text-muted-foreground">无</span>;
              }
              return (
                <div className="flex flex-wrap gap-1">
                  {r.on_sale_shops.map((s) => (
                    <span
                      key={s.shop_id}
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                        s.low
                          ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
                          : "bg-muted/50 border-border text-foreground"
                      }`}
                      title={`库存 ${s.stock_qty}`}
                    >
                      {s.shop_name}
                      <span className="tabular-nums opacity-70">{s.stock_qty}</span>
                    </span>
                  ))}
                </div>
              );
            },
          },
          {
            header: "状态",
            cell: (r: AggItem) => {
              const meta = STATUS_META[r.status];
              return (
                <Badge variant="outline" className={`text-[10px] ${meta.cls}`}>
                  {meta.label}
                </Badge>
              );
            },
          },
          {
            header: "操作",
            cell: (r: AggItem) => {
              const row = pickRowForShop(r);
              const shop = row ? shops.find((s) => s.id === row.shop_id) : null;
              if (!row || !shop) return null;
              const disabledHint =
                shopId === "all" ? "默认对该商品的首选门店操作" : undefined;
              return (
                <div className="flex items-center gap-1" title={disabledHint}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setDialog({ mode: "in", targetItem: row, targetShop: shop })}
                  >
                    <ArrowDownToLine className="h-3 w-3 mr-1" />
                    调入
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setDialog({ mode: "out", sourceItem: row, sourceShop: shop })}
                  >
                    <ArrowUpFromLine className="h-3 w-3 mr-1" />
                    调出
                  </Button>
                </div>
              );
            },
          },
        ]}
      />

      {dialog && (
        <TransferDialog
          open={!!dialog}
          onOpenChange={(o) => !o && setDialog(null)}
          shops={shops}
          context={dialog}
          onSuccess={refresh}
        />
      )}
    </div>
  );
}
