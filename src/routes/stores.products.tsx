import { useMemo, useState } from "react";
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

export const Route = createFileRoute("/stores/products")({
  head: () => ({
    meta: [
      { title: "门店商品库 · 门店加盟" },
      { name: "description", content: "查看各门店有赞商品并执行库存调拨" },
    ],
  }),
  component: ShopProductsPage,
});

type Item = {
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
type Shop = { id: string; shop_name: string; kdt_id: number; role: string };

function ShopProductsPage() {
  const qc = useQueryClient();
  const syncFn = useServerFn(syncYouzanItems);
  const [shopId, setShopId] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [listed, setListed] = useState<string>("all");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { mode: "in"; targetItem: Item; targetShop: Shop }
    | { mode: "out"; sourceItem: Item; sourceShop: Shop }
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

  const items = (data?.items ?? []) as Item[];
  const shops = (data?.shops ?? []) as Shop[];
  const shopMap = useMemo(() => new Map(shops.map((s) => [s.id, s])), [shops]);

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

  return (
    <div>
      <PageHeader
        title="门店商品库"
        description="查看各门店有赞商品的库存与状态，支持调拨入库 / 出库"
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
        rowKey={(r: Item) => r.id}
        data={items}
        columns={[
          {
            header: "商品",
            cell: (r: Item) => (
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
                  <p className="text-[10px] text-muted-foreground tabular-nums">item {r.item_id}</p>
                </div>
              </div>
            ),
          },
          {
            header: "门店",
            cell: (r: Item) => (
              <span className="text-xs">{shopMap.get(r.shop_id)?.shop_name ?? r.kdt_id}</span>
            ),
          },
          {
            header: "价格",
            cell: (r: Item) => <span className="tabular-nums">¥{Number(r.price ?? 0).toFixed(2)}</span>,
            className: "text-right",
          },
          {
            header: "库存",
            cell: (r: Item) => (
              <span className={`tabular-nums font-medium ${r.stock_qty === 0 ? "text-destructive" : ""}`}>
                {r.stock_qty}
              </span>
            ),
            className: "text-right",
          },
          {
            header: "状态",
            cell: (r: Item) => (
              <Badge variant={r.is_listed ? "default" : "secondary"} className="text-[10px]">
                {r.is_listed ? "在售" : "下架"}
              </Badge>
            ),
          },
          {
            header: "操作",
            cell: (r: Item) => {
              const shop = shopMap.get(r.shop_id);
              if (!shop) return null;
              return (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setDialog({ mode: "in", targetItem: r, targetShop: shop })}
                  >
                    <ArrowDownToLine className="h-3 w-3 mr-1" />
                    调入
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => setDialog({ mode: "out", sourceItem: r, sourceShop: shop })}
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
