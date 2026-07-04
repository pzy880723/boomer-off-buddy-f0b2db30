import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Package2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addShopStock } from "@/lib/shop-products.functions";

export function ReceiveStockDialog({
  open,
  onOpenChange,
  shopId,
  shopName,
  skuId,
  skuName,
  currentQty,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  shopId: string;
  shopName: string;
  skuId: string;
  skuName: string;
  currentQty: number;
  onSuccess?: () => void;
}) {
  const fn = useServerFn(addShopStock);
  const [delta, setDelta] = useState<string>("1");

  const mut = useMutation({
    mutationFn: async () => {
      const n = Number(delta);
      if (!Number.isFinite(n) || n === 0) throw new Error("请填写非 0 数量");
      return fn({ data: { shop_id: shopId, sku_id: skuId, delta: n } });
    },
    onSuccess: (r) => {
      const msg = [
        `已更新库存至 ${r.new_qty}`,
        r.listing_created ? "已同步上架到有赞" : null,
        r.listing_error ? `⚠️ 有赞上架失败：${r.listing_error}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (r.listing_error) toast.warning(msg);
      else toast.success(msg);
      onSuccess?.();
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package2 className="h-4 w-4" /> 调整门店库存
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium">{shopName}</span> · {skuName}
            <br />
            当前库存 <span className="tabular-nums">{currentQty}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label>变更数量（正数入库，负数出库）</Label>
          <div className="flex gap-2">
            {[1, 5, 10, -1].map((n) => (
              <Button
                key={n}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDelta(String(n))}
              >
                {n > 0 ? `+${n}` : n}
              </Button>
            ))}
          </div>
          <Input
            type="number"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            className="tabular-nums"
          />
          <p className="text-xs text-muted-foreground">
            保存后会同步推送到有赞门店；如果这个 SKU 在该门店还未上架，会自动调
            item.add 创建商品。
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "保存中…" : "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
