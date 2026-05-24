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
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createStandardSkus } from "@/lib/inventory.functions";
import { PRICE_TIERS } from "@/lib/inventory.helpers";
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

  const toggleTier = (t: number) =>
    setTiers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t].sort((a, b) => a - b)));

  const mut = useMutation({
    mutationFn: async () => {
      if (!meta.category || !meta.name.trim()) throw new Error("类目 / 品名 必填");
      if (tiers.length === 0) throw new Error("至少选择一个价格档");
      return fn({
        data: {
          category: meta.category as never,
          name: meta.name.trim(),
          sku_code: meta.sku_code.trim() || null,
          weight_g: meta.weight ? Number(meta.weight) : null,
          image_url: meta.imageUrl.trim() || null,
          notes: meta.notes.trim() || null,
          price_tiers: tiers,
        },
      });
    },
    onSuccess: (res) => {
      const n = res.skus.length;
      toast.success(`已创建 ${n} 个标准 SKU`);
      reset();
      onOpenChange(false);
      onCreated?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const reset = () => {
    setMeta(emptySkuMeta);
    setTiers([]);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建标准商品</DialogTitle>
          <DialogDescription>
            选中多个标准价格档将一次生成多条 SKU，共用品名和图片
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <SkuMetaFields state={meta} onChange={setMeta} />
          <div className="space-y-1.5">
            <Label>标准价格档 *（可多选）</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRICE_TIERS.map((t) => {
                const active = tiers.includes(t);
                return (
                  <Button
                    key={t}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    onClick={() => toggleTier(t)}
                  >
                    ¥{t}
                  </Button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              已选 {tiers.length} 档 → 将生成 {tiers.length} 个 SKU
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : `创建 ${tiers.length || ""} 个 SKU`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
