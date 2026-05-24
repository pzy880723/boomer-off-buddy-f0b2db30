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
import { createSku } from "@/lib/inventory.functions";
import {
  SkuFormFields,
  emptySkuForm,
  resolveSkuFormPrice,
  type SkuFormState,
} from "./sku-form-fields";

export function SkuFormDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const createFn = useServerFn(createSku);
  const [state, setState] = useState<SkuFormState>(emptySkuForm);

  const mut = useMutation({
    mutationFn: async () => {
      const price = resolveSkuFormPrice(state);
      if (!state.category || price == null || !state.name.trim()) {
        throw new Error("类目 / 价格 / 品名 必填");
      }
      if (state.kind === "pack" && !state.packPieces) {
        throw new Error("组包请填写内含件数");
      }
      return createFn({
        data: {
          category: state.category as never,
          price_tier: price,
          is_custom_price: state.priceMode === "custom",
          name: state.name.trim(),
          kind: state.kind,
          pack_pieces: state.kind === "pack" ? Number(state.packPieces) : null,
          weight_g: state.weight ? Number(state.weight) : null,
          image_url: state.imageUrl.trim() || null,
          notes: state.notes.trim() || null,
          status: "active",
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`SKU 已创建，EPC：${res.sku.epc}`);
      onOpenChange(false);
      setState(emptySkuForm);
      onCreated?.(res.sku.id);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建 SKU</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <SkuFormFields state={state} onChange={setState} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : "创建并生成 EPC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
