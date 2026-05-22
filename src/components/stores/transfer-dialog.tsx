import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { createTransfer, listShopProducts } from "@/lib/stock-transfer.functions";
import { listSkus } from "@/lib/inventory.functions";

type Shop = { id: string; shop_name: string; kdt_id: number; role: string };
type Item = {
  id: string;
  shop_id: string;
  item_id: number;
  title: string | null;
  stock_qty: number;
};
type Sku = { id: string; name: string; stock_qty: number; epc: string };

type Context =
  | { mode: "in"; targetItem: Item; targetShop: Shop }
  | { mode: "out"; sourceItem: Item; sourceShop: Shop };

const REASONS = [
  { v: "offline_sale", l: "线下销售" },
  { v: "damaged", l: "损坏报废" },
  { v: "lost", l: "丢失" },
  { v: "gift", l: "赠送/样品" },
  { v: "other", l: "其它" },
];

export function TransferDialog({
  open,
  onOpenChange,
  shops,
  context,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  shops: Shop[];
  context: Context;
  onSuccess?: () => void;
}) {
  const createFn = useServerFn(createTransfer);
  const skuListFn = useServerFn(listSkus);
  const itemListFn = useServerFn(listShopProducts);

  // "in" 模式：往目标店调入，源可以是 仓库 SKU 或 别的门店商品
  // "out" 模式：从源店调出，目标可以是 别的门店 / 仓库 SKU / 销售损耗
  const [kind, setKind] = useState<"wh_to_shop" | "shop_to_shop" | "shop_to_wh" | "consume">(
    context.mode === "in" ? "wh_to_shop" : "consume",
  );
  const [qty, setQty] = useState(1);
  const [operator, setOperator] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("offline_sale");
  const [skuId, setSkuId] = useState<string>("");
  const [otherShopId, setOtherShopId] = useState<string>("");
  const [otherItemId, setOtherItemId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setKind(context.mode === "in" ? "wh_to_shop" : "consume");
    setQty(1);
    setSkuId("");
    setOtherShopId("");
    setOtherItemId("");
  }, [context]);

  // 仓库 SKU 候选
  const { data: skuData } = useQuery({
    queryKey: ["sku-picker"],
    queryFn: () => skuListFn({ data: { limit: 500 } }),
    enabled:
      (context.mode === "in" && kind === "wh_to_shop") ||
      (context.mode === "out" && kind === "shop_to_wh"),
  });
  const skus = ((skuData?.rows ?? []) as Sku[]).filter((s) => s.stock_qty > 0 || kind === "shop_to_wh");

  // 另一门店商品候选
  const { data: otherItemsData } = useQuery({
    queryKey: ["other-shop-items", otherShopId],
    queryFn: () => itemListFn({ data: { shop_id: otherShopId, limit: 500 } }),
    enabled: !!otherShopId && (kind === "shop_to_shop"),
  });
  const otherItems = (otherItemsData?.items ?? []) as Item[];

  const submit = async () => {
    if (qty < 1) return toast.error("数量需 ≥ 1");
    setBusy(true);
    try {
      const payload: {
        kind: typeof kind;
        qty: number;
        operator: string | null;
        notes: string | null;
        from_shop_id?: string;
        to_shop_id?: string;
        from_sku_id?: string;
        to_sku_id?: string;
        from_youzan_item_id?: number;
        to_youzan_item_id?: number;
        reason?: string;
      } = {
        kind,
        qty,
        operator: operator || null,
        notes: notes || null,
      };
      if (context.mode === "in") {
        // 调入目标店
        payload.to_shop_id = context.targetShop.id;
        payload.to_youzan_item_id = context.targetItem.item_id;
        if (kind === "wh_to_shop") {
          if (!skuId) throw new Error("请选择仓库 SKU");
          payload.from_sku_id = skuId;
        } else if (kind === "shop_to_shop") {
          if (!otherShopId || !otherItemId) throw new Error("请选择来源门店及商品");
          payload.from_shop_id = otherShopId;
          payload.from_youzan_item_id = Number(otherItemId);
        }
      } else {
        // 调出源店
        payload.from_shop_id = context.sourceShop.id;
        payload.from_youzan_item_id = context.sourceItem.item_id;
        if (kind === "shop_to_shop") {
          if (!otherShopId || !otherItemId) throw new Error("请选择目标门店及商品");
          payload.to_shop_id = otherShopId;
          payload.to_youzan_item_id = Number(otherItemId);
        } else if (kind === "shop_to_wh") {
          if (!skuId) throw new Error("请选择仓库 SKU");
          payload.to_sku_id = skuId;
        } else if (kind === "consume") {
          payload.reason = reason;
        }
      }

      const r = await createFn({ data: payload });
      if (r.ok) {
        toast.success(r.message);
        onSuccess?.();
        onOpenChange(false);
      } else {
        toast.error(r.message);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    context.mode === "in"
      ? `调入：${context.targetShop.shop_name} · ${context.targetItem.title ?? ""}`
      : `调出：${context.sourceShop.shop_name} · ${context.sourceItem.title ?? ""}`;

  // 候选调拨类型
  const kinds =
    context.mode === "in"
      ? [
          { v: "wh_to_shop", l: "从仓库调入" },
          { v: "shop_to_shop", l: "从其它门店调入" },
        ]
      : [
          { v: "shop_to_shop", l: "调到其它门店" },
          { v: "shop_to_wh", l: "退回仓库" },
          { v: "consume", l: "销售 / 损耗出库" },
        ];

  const currentStock =
    context.mode === "out" ? context.sourceItem.stock_qty : context.targetItem.stock_qty;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription>
            当前库存 <Badge variant="secondary">{currentStock}</Badge> · 调拨即同步有赞
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">调拨方式</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="h-9 mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k.v} value={k.v}>
                    {k.l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 仓库 SKU 选择器 */}
          {(kind === "wh_to_shop" || kind === "shop_to_wh") && (
            <div>
              <Label className="text-xs">
                {kind === "wh_to_shop" ? "来源仓库 SKU" : "目标仓库 SKU"}
              </Label>
              <Select value={skuId} onValueChange={setSkuId}>
                <SelectTrigger className="h-9 mt-1">
                  <SelectValue placeholder="选择仓库 SKU" />
                </SelectTrigger>
                <SelectContent>
                  {skus.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} · 在库 {s.stock_qty}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 另一门店选择器 */}
          {kind === "shop_to_shop" && (
            <>
              <div>
                <Label className="text-xs">
                  {context.mode === "in" ? "来源门店" : "目标门店"}
                </Label>
                <Select value={otherShopId} onValueChange={setOtherShopId}>
                  <SelectTrigger className="h-9 mt-1">
                    <SelectValue placeholder="选择门店" />
                  </SelectTrigger>
                  <SelectContent>
                    {shops
                      .filter(
                        (s) =>
                          s.id !==
                          (context.mode === "in" ? context.targetShop.id : context.sourceShop.id),
                      )
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.shop_name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {otherShopId && (
                <div>
                  <Label className="text-xs">
                    {context.mode === "in" ? "来源商品" : "目标商品"}
                  </Label>
                  <Select value={otherItemId} onValueChange={setOtherItemId}>
                    <SelectTrigger className="h-9 mt-1">
                      <SelectValue placeholder="选择该店有赞商品" />
                    </SelectTrigger>
                    <SelectContent>
                      {otherItems.map((i) => (
                        <SelectItem key={i.id} value={String(i.item_id)}>
                          {i.title || "(无标题)"} · 库存 {i.stock_qty}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          {kind === "consume" && (
            <div>
              <Label className="text-xs">出库原因</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger className="h-9 mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r.v} value={r.v}>
                      {r.l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">数量</Label>
              <Input
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                className="h-9 mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">操作员</Label>
              <Input
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                placeholder="选填"
                className="h-9 mt-1"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">备注</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="选填"
              className="mt-1 min-h-[60px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            提交调拨
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
