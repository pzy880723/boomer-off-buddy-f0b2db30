import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Search, Link2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  searchYouzanItems,
  linkSkuToYouzanItem,
  pushSkuAsNewYouzanItem,
} from "@/lib/youzan-sync.functions";

export function BindYouzanDialog({
  open,
  onOpenChange,
  skuId,
  skuName,
  onBound,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  skuId: string;
  skuName?: string;
  onBound?: () => void;
}) {
  const search = useServerFn(searchYouzanItems);
  const link = useServerFn(linkSkuToYouzanItem);
  const pushNew = useServerFn(pushSkuAsNewYouzanItem);

  const [kw, setKw] = useState(skuName ?? "");
  const [submittedKw, setSubmittedKw] = useState(skuName ?? "");
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);

  const q = useQuery({
    queryKey: ["yz-search", submittedKw],
    queryFn: () => search({ data: { q: submittedKw, only_unbound: false, limit: 30 } }),
    enabled: open,
  });
  const rows = q.data?.rows ?? [];

  const handleBind = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const r = await link({ data: { sku_id: skuId, yz_item_id: picked } });
      toast.success(r.message);
      onBound?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  };

  const handlePush = async () => {
    setBusy(true);
    try {
      const r = await pushNew({ data: { sku_id: skuId } });
      toast.success(`已推送，有赞 item_id = ${r.yz_item_id}`);
      onBound?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "推送失败");
    } finally {
      setBusy(false);
      setConfirmPush(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" /> 绑定有赞商品
          </DialogTitle>
          <DialogDescription>
            优先搜索绑定有赞总部已有的商品；只有确认有赞那边不存在时，才用「推送新建」。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="search">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="search">搜索已有商品绑定（推荐）</TabsTrigger>
            <TabsTrigger value="push">推送新建（应急）</TabsTrigger>
          </TabsList>

          <TabsContent value="search" className="mt-3 space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
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

            <div className="max-h-80 overflow-y-auto rounded border">
              {q.isLoading ? (
                <p className="p-4 text-center text-sm text-muted-foreground">加载中…</p>
              ) : rows.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  没搜到，先到「有赞」页面同步一次总部商品，或换个关键字
                </p>
              ) : (
                rows.map((r) => {
                  const isPicked = picked === r.item_id;
                  const isBound = !!r.bound_sku_id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      disabled={isBound}
                      onClick={() => setPicked(r.item_id)}
                      className={`flex w-full items-center gap-3 border-b p-2 text-left text-sm last:border-b-0 ${
                        isPicked ? "bg-primary/10" : "hover:bg-muted/50"
                      } ${isBound ? "opacity-50" : ""}`}
                    >
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-muted">
                        {r.pic_url ? (
                          <img src={r.pic_url} alt="" className="h-full w-full object-cover" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 font-medium">{r.title}</p>
                        <p className="text-[11px] text-muted-foreground">
                          item_id {r.item_id} · ¥{r.price} · 有赞库存 {r.stock_qty}
                        </p>
                      </div>
                      {isBound && <Badge variant="secondary">已被占用</Badge>}
                      {!isBound && !r.is_listed && <Badge variant="outline">已下架</Badge>}
                    </button>
                  );
                })
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button disabled={!picked || busy} onClick={handleBind}>
                {busy ? "绑定中…" : "确认绑定并按本地库存同步"}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="push" className="mt-3 space-y-3">
            {!confirmPush ? (
              <>
                <p className="text-sm text-muted-foreground">
                  会在有赞总部账号下用本地 SKU 资料新建一个商品。<br />
                  <span className="text-destructive">
                    ⚠️ 若有赞那边已有同名/同款商品，会产生重复商品，请确认后再操作。
                  </span>
                </p>
                <DialogFooter>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    取消
                  </Button>
                  <Button variant="destructive" onClick={() => setConfirmPush(true)}>
                    我已确认有赞没有这个商品
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <p className="text-sm">
                  即将创建有赞商品并绑定到本地 SKU
                  <span className="ml-1 font-medium">{skuName ?? skuId}</span>。
                </p>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmPush(false)}>
                    返回
                  </Button>
                  <Button disabled={busy} onClick={handlePush}>
                    {busy ? "推送中…" : "确认推送新建"}
                  </Button>
                </DialogFooter>
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
