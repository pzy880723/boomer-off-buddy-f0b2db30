import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createStandardSkus } from "@/lib/inventory.functions";
import { generateEpc } from "@/lib/inventory.helpers";
import { PriceTierEditor } from "./price-tier-editor";
import { SkuMetaFields, emptySkuMeta, type SkuMetaState } from "./sku-meta-fields";

export function StandardSkuDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
}) {
  const fn = useServerFn(createStandardSkus);
  const [meta, setMeta] = useState<SkuMetaState>(emptySkuMeta);
  const [tiers, setTiers] = useState<number[]>([]);

  // 缓存 (category|tier) -> epc，避免重渲染时换随机串
  const epcCacheRef = useRef<Map<string, string>>(new Map());
  const epcKey = (cat: string, t: number) => `${cat}|${t}`;
  const getEpc = (cat: string, t: number) => {
    const k = epcKey(cat, t);
    const cached = epcCacheRef.current.get(k);
    if (cached) return cached;
    const v = generateEpc(cat, t);
    epcCacheRef.current.set(k, v);
    return v;
  };

  const sortedSelected = useMemo(() => [...tiers].sort((a, b) => a - b), [tiers]);

  const reset = () => {
    setMeta(emptySkuMeta);
    setTiers([]);
    epcCacheRef.current.clear();
  };

  const mut = useMutation({
    mutationFn: async () => {
      if (!meta.category || !meta.name.trim()) throw new Error("类目 / 品名 必填");
      if (sortedSelected.length === 0) throw new Error("至少选择一个价格档");
      const epc_map: Record<string, string> = {};
      for (const t of sortedSelected) epc_map[String(t)] = getEpc(meta.category, t);
      return fn({
        data: {
          category: meta.category as never,
          name: meta.name.trim(),
          sku_code: meta.sku_code.trim() || null,
          weight_g: meta.weight ? Number(meta.weight) : null,
          image_url: meta.imageUrl.trim() || null,
          notes: meta.notes.trim() || null,
          price_tiers: sortedSelected,
          epc_map,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`已创建 ${res.skus.length} 个标准 SKU`);
      reset();
      onOpenChange(false);
      onCreated?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建标准商品</DialogTitle>
          <DialogDescription>
            标准商品按「价格档」分类：每个价格档 = 一个独立 SKU = 一个价格 = 一段规格编码。RFID 标签在打印时已绑定商品编码 + 规格编码，扫描枪扫一下即库存 +1。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <SkuMetaFields state={meta} onChange={setMeta} hideGrade hideWeight />
          <div className="space-y-2">
            <Label>价格档 *（每档即一个 SKU）</Label>
            <PriceTierEditor value={tiers} onChange={setTiers} />
            <p className="text-xs text-muted-foreground">
              已选 {sortedSelected.length} 档 → 将生成 {sortedSelected.length} 个 SKU
            </p>
          </div>


          {sortedSelected.length > 0 && meta.category && (
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">将生成的 SKU 编码（EPC）</p>
              <ul className="space-y-1">
                {sortedSelected.map((t) => (
                  <li key={t} className="flex items-center justify-between gap-2 text-xs">
                    <span className="tabular-nums font-medium">¥{t}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{getEpc(meta.category, t)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : `创建 ${sortedSelected.length || ""} 个 SKU`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
