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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkuMetaFields, type SkuMetaState } from "./sku-meta-fields";
import { updateSku } from "@/lib/inventory.functions";
import type { SkuRow } from "@/lib/inventory.helpers";

export function SkuEditDialog({
  sku,
  open,
  onOpenChange,
  onSaved,
}: {
  sku: SkuRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved?: () => void;
}) {
  const fn = useServerFn(updateSku);
  const [meta, setMeta] = useState<SkuMetaState>({
    category: "",
    name: "",
    sku_code: "",
    weight: "",
    imageUrl: "",
    notes: "",
    grade: "",
  });
  const [price, setPrice] = useState("");

  const isStandard = !!sku && sku.kind === "single" && !sku.is_custom_price;
  const priceEditable = !!sku && !isStandard;

  useEffect(() => {
    if (sku && open) {
      setMeta({
        category: sku.category,
        name: sku.name,
        sku_code: sku.sku_code ?? "",
        weight: sku.weight_g != null ? String(sku.weight_g) : "",
        imageUrl: sku.image_url ?? "",
        notes: sku.notes ?? "",
        grade: (sku as { grade?: string | null }).grade ?? "",
      });
      setPrice(String(sku.price_tier ?? ""));
    }
  }, [sku, open]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!sku) throw new Error("缺少 SKU");
      if (!meta.name.trim()) throw new Error("品名必填");
      const patch: Record<string, unknown> = {
        name: meta.name.trim(),
        sku_code: meta.sku_code.trim() || null,
        weight_g: meta.weight ? Number(meta.weight) : null,
        image_url: meta.imageUrl.trim() || null,
        notes: meta.notes.trim() || null,
        grade: meta.grade || null,
      };
      if (priceEditable) {
        const p = Number(price);
        if (!Number.isFinite(p) || p <= 0) throw new Error("请输入合法售价");
        patch.price_tier = Math.round(p * 100) / 100;
      }
      return fn({ data: { id: sku.id, patch: patch as never } });
    },
    onSuccess: () => {
      toast.success("已保存");
      onOpenChange(false);
      onSaved?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const title = isStandard
    ? "编辑价格档子 SKU"
    : sku?.kind === "bundle"
      ? "编辑组包商品"
      : "编辑自定义商品";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {isStandard && (
          <p className="text-xs text-muted-foreground">
            该 SKU 属于某个标准商品的价格档，价格档不可修改。如需调整品名 / 图片 / 编码，请在标准商品详情页操作。
          </p>
        )}
        <div className="py-2 space-y-4">
          <SkuMetaFields state={meta} onChange={setMeta} hideCategory />
          <div className="space-y-1.5">
            <Label>售价 (¥){priceEditable ? " *" : ""}</Label>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              disabled={!priceEditable}
            />
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
