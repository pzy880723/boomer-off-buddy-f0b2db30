import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Search, Link2, CheckCircle2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listYouzanShops } from "@/lib/youzan.functions";
import { listYouzanItemsByShop } from "@/lib/youzan-sync.functions";

// 浏览每家门店已同步到本地的商品库；后续会在这里直接发起"双向绑定"。
export function ShopItemsPanel() {
  const fetchShops = useServerFn(listYouzanShops);
  const fetchItems = useServerFn(listYouzanItemsByShop);

  const shopsQ = useQuery({
    queryKey: ["youzan-shops-min"],
    queryFn: () => fetchShops(),
  });
  const shops = shopsQ.data?.shops ?? [];

  const [shopId, setShopId] = useState<string | null>(null);
  const activeShopId =
    shopId ?? shops.find((s) => s.role === "hq")?.id ?? shops[0]?.id ?? null;

  const [kw, setKw] = useState("");
  const [submittedKw, setSubmittedKw] = useState("");

  const itemsQ = useQuery({
    queryKey: ["yz-shop-items", activeShopId, submittedKw],
    queryFn: () =>
      fetchItems({
        data: { shop_id: activeShopId!, q: submittedKw || undefined, limit: 100 },
      }),
    enabled: !!activeShopId,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={activeShopId ?? ""}
          onValueChange={(v) => setShopId(v)}
        >
          <SelectTrigger className="w-[260px]">
            <SelectValue placeholder="选择门店" />
          </SelectTrigger>
          <SelectContent>
            {shops.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.role === "hq" ? "🏢 " : "🏬 "}
                {s.shop_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="按品名 / item_id 搜索（回车）"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setSubmittedKw(kw.trim())}
          />
        </div>
        <Button variant="outline" onClick={() => setSubmittedKw(kw.trim())}>
          搜索
        </Button>
      </div>

      {itemsQ.isLoading ? (
        <p className="rounded border p-6 text-center text-sm text-muted-foreground">
          加载中…
        </p>
      ) : (itemsQ.data?.rows ?? []).length === 0 ? (
        <p className="rounded border p-6 text-center text-sm text-muted-foreground">
          这家门店暂无已同步的商品，请到上方门店卡片点「同步」拉取
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {(itemsQ.data?.rows ?? []).map((r) => (
            <div
              key={r.id}
              className="flex items-start gap-3 rounded border p-2 hover:border-primary/40"
            >
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded bg-muted">
                {r.pic_url ? (
                  <img src={r.pic_url} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm font-medium" title={r.title ?? undefined}>
                  {r.title}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  item {r.item_id} · ¥{r.price} · 库存 {r.stock_qty}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {!r.is_listed && <Badge variant="outline">已下架</Badge>}
                  {r.link ? (
                    <Badge
                      variant="secondary"
                      className="gap-1 text-[10px]"
                      title={`已绑定本地 SKU：${r.link.sku_name || r.link.sku_id}`}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      已绑定 {r.link.sku_name || r.link.sku_id.slice(0, 6)}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      <Link2 className="h-3 w-3" />
                      未绑定
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
