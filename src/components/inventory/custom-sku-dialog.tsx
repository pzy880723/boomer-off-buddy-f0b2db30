import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCustomSku } from "@/lib/inventory.functions";
import { SkuMetaFields, emptySkuMeta, type SkuMetaState } from "./sku-meta-fields";
import { DefaultShopsSelector } from "./default-shops-selector";

export function CustomSkuForm({
  meta,
  setMeta,
  price,
  setPrice,
  mobile,
}: {
  meta: SkuMetaState;
  setMeta: (s: SkuMetaState) => void;
  price: string;
  setPrice: (v: string) => void;
  mobile?: boolean;
}) {
  return (
    <div className="space-y-4">
      <SkuMetaFields state={meta} onChange={setMeta} mobile={mobile} />
      <div className="space-y-1.5">
        <Label>售价 (¥) *</Label>
        <Input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="自定义售价"
        />
      </div>
    </div>
  );
}

export function useCustomSkuMutation(onDone: (res?: { sku: { id: string; epc: string } }) => void) {
  const fn = useServerFn(createCustomSku);
  return useMutation({
    mutationFn: async (input: { meta: SkuMetaState; price: string }) => {
      const { meta, price } = input;
      if (!meta.category || !meta.name.trim()) throw new Error("类目 / 品名 必填");
      const p = Number(price);
      if (!Number.isFinite(p) || p <= 0) throw new Error("请输入合法售价");
      return fn({
        data: {
          category: meta.category as never,
          name: meta.name.trim(),
          sku_code: meta.sku_code.trim() || null,
          weight_g: meta.weight ? Number(meta.weight) : null,
          image_url: meta.imageUrl.trim() || null,
          notes: meta.notes.trim() || null,
          grade: (meta.grade || null) as "N" | "S" | "A" | "B" | "C" | "J" | null,
          price: Math.round(p * 100) / 100,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`已创建，EPC：${res.sku.epc}`);
      onDone(res as { sku: { id: string; epc: string } });
    },
    onError: (e) => toast.error((e as Error).message),
  });
}

export function CustomSkuDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (res?: { sku: { id: string; epc: string } }) => void;
}) {
  const [meta, setMeta] = useState<SkuMetaState>(emptySkuMeta);
  const [price, setPrice] = useState("");
  const [defaultShopIds, setDefaultShopIds] = useState<string[]>([]);
  const reset = () => { setMeta(emptySkuMeta); setPrice(""); setDefaultShopIds([]); };
  const mut = useCustomSkuMutation((res) => {
    reset();
    onOpenChange(false);
    onCreated?.(res);
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建自定义商品</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-4">
          <CustomSkuForm meta={meta} setMeta={setMeta} price={price} setPrice={setPrice} />
          <DefaultShopsSelector value={defaultShopIds} onChange={setDefaultShopIds} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate({ meta, price, default_shop_ids: defaultShopIds })} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : "创建并生成 EPC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
