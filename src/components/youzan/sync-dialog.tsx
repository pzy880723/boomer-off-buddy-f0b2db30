import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Package, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { syncYouzanItems, syncYouzanOrders } from "@/lib/youzan.functions";

function toDateInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function SyncDialog({
  shopId,
  shopName,
  trigger,
}: {
  shopId: string;
  shopName: string;
  trigger: React.ReactNode;
}) {
  const qc = useQueryClient();
  const itemsFn = useServerFn(syncYouzanItems);
  const ordersFn = useServerFn(syncYouzanOrders);

  const [open, setOpen] = useState(false);
  const [itemsBusy, setItemsBusy] = useState(false);
  const [ordersBusy, setOrdersBusy] = useState(false);
  const [itemsResult, setItemsResult] = useState<string | null>(null);
  const [ordersResult, setOrdersResult] = useState<string | null>(null);

  const today = new Date();
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  const [start, setStart] = useState(toDateInput(monthAgo));
  const [end, setEnd] = useState(toDateInput(today));

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["youzan-summary"] });
    qc.invalidateQueries({ queryKey: ["youzan-breakdown"] });
    qc.invalidateQueries({ queryKey: ["youzan-sync-logs"] });
  };

  const handleItems = async () => {
    setItemsBusy(true);
    setItemsResult(null);
    try {
      const r = await itemsFn({ data: { shop_id: shopId } });
      setItemsResult(r.message);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      invalidateAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setItemsResult(msg);
      toast.error(msg);
    } finally {
      setItemsBusy(false);
    }
  };

  const handleOrders = async () => {
    setOrdersBusy(true);
    setOrdersResult(null);
    try {
      const r = await ordersFn({
        data: {
          shop_id: shopId,
          start: new Date(start + "T00:00:00").toISOString(),
          end: new Date(end + "T23:59:59").toISOString(),
        },
      });
      setOrdersResult(r.message);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      invalidateAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOrdersResult(msg);
      toast.error(msg);
    } finally {
      setOrdersBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-primary" />
            同步「{shopName}」
          </DialogTitle>
          <DialogDescription>
            手动从有赞拉取最新数据。建议先同步商品，再同步订单。
          </DialogDescription>
        </DialogHeader>

        {/* 商品同步 */}
        <div className="rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">商品全量同步</p>
                <p className="text-[11px] text-muted-foreground">
                  在售 + 已下架，含价格、库存、状态
                </p>
              </div>
            </div>
            <Button size="sm" onClick={handleItems} disabled={itemsBusy}>
              {itemsBusy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              开始同步
            </Button>
          </div>
          {itemsResult && (
            <p className="mt-2 text-[11px] text-muted-foreground">{itemsResult}</p>
          )}
        </div>

        {/* 订单同步 */}
        <div className="rounded-md border p-3">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">订单同步</p>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-muted-foreground">起始日期</Label>
              <Input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">结束日期</Label>
              <Input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setStart(toDateInput(new Date(Date.now() - 7 * 86_400_000)));
                  setEnd(toDateInput(new Date()));
                }}
              >
                7天
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setStart(toDateInput(new Date(Date.now() - 30 * 86_400_000)));
                  setEnd(toDateInput(new Date()));
                }}
              >
                30天
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => {
                  setStart(toDateInput(new Date(Date.now() - 90 * 86_400_000)));
                  setEnd(toDateInput(new Date()));
                }}
              >
                90天
              </Button>
            </div>
            <Button size="sm" onClick={handleOrders} disabled={ordersBusy}>
              {ordersBusy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              开始同步
            </Button>
          </div>
          {ordersResult && (
            <p className="mt-2 text-[11px] text-muted-foreground">{ordersResult}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
