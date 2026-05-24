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
import { SkuMetaFields, type SkuMetaState } from "./sku-meta-fields";
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
  });

  useEffect(() => {
    if (group && open) {
      setMeta({
        category: group.category,
        name: group.name,
        sku_code: group.code ?? "",
        weight: group.weight_g != null ? String(group.weight_g) : "",
        imageUrl: group.image_url ?? "",
        notes: group.notes ?? "",
      });
    }
  }, [group, open]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!group) throw new Error("缺少商品");
      if (!meta.name.trim()) throw new Error("品名必填");
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
        },
      });
    },
    onSuccess: () => {
      toast.success("已保存");
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
          类目无法修改；保存后会同步到该商品下的全部价格档子 SKU。
        </p>
        <div className="py-2">
          <SkuMetaFields state={meta} onChange={setMeta} hideCategory />
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
