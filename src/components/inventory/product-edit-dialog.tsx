import { useEffect, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { SkuMetaFields, type SkuMetaState } from "./sku-meta-fields";
import { PriceTierEditor } from "./price-tier-editor";
import { updateStandardProduct } from "@/lib/inventory.functions";
import type { StandardProductGroup } from "@/lib/inventory.helpers";

export function ProductEditDialog({
  group,
  open,
  onOpenChange,
  onSaved,
}: {
  group: StandardProductGroup | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: () => void;
}) {
  const fn = useServerFn(updateStandardProduct);
  const [meta, setMeta] = useState<SkuMetaState>({
    category: "",
    name: "",
    sku_code: "",
    weight: "",
    imageUrl: "",
    notes: "",
    grade: "",
  });
  const [tiers, setTiers] = useState<number[]>([]);

  useEffect(() => {
    if (group && open) {
      setMeta({
        category: group.category,
        name: group.name,
        sku_code: group.code ?? "",
        weight: group.weight_g != null ? String(group.weight_g) : "",
        imageUrl: group.image_url ?? "",
        notes: group.notes ?? "",
        grade: "",
      });
      setTiers([...group.tiers].sort((a, b) => a - b));
    }
  }, [group, open]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!group) throw new Error("缺少商品");
      if (!meta.name.trim()) throw new Error("品名必填");
      if (tiers.length === 0) throw new Error("至少保留一个价格档");
      return fn({
        data: {
          key: group.key,
          patch: {
            name: meta.name.trim(),
            sku_code: meta.sku_code.trim() || null,
            weight_g: meta.weight ? Number(meta.weight) : null,
            image_url: meta.imageUrl.trim() || null,
            notes: meta.notes.trim() || null,
          },
          price_tiers: tiers,
        },
      });
    },
    onSuccess: (res) => {
      const r = res as { added?: number; removed?: number };
      const parts: string[] = ["已保存"];
      if (r.added) parts.push(`新增 ${r.added} 档`);
      if (r.removed) parts.push(`删除 ${r.removed} 档`);
      toast.success(parts.join(" · "));
      onOpenChange(false);
      onSaved?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>编辑标准商品</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          类目无法修改；保存后会同步到该商品下的全部价格档子 SKU。每个价格档 = 一个独立 SKU = 一个价格 = 一段规格编码。新增的价格档会自动生成 EPC，删除的价格档若仍有库存会阻止保存。
        </p>
        <div className="py-2 space-y-4">
          <SkuMetaFields state={meta} onChange={setMeta} hideCategory hideGrade hideWeight />

          <div className="space-y-1.5">
            <Label>价格档 *</Label>
            <PriceTierEditor value={tiers} onChange={setTiers} />
            <p className="text-[11px] text-muted-foreground">
              点选 = 该商品启用此档；点 + 可添加新档（全局共享）。
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
