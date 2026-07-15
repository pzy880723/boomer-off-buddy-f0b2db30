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
import { createCustomSku } from "@/lib/inventory.functions";
import { SkuMetaFields, emptySkuMeta, type SkuMetaState } from "./sku-meta-fields";
import { DefaultShopsSelector } from "./default-shops-selector";
import { SmartSkuCapture } from "./smart-sku-capture";
import { Sparkles } from "lucide-react";

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
  useEffect(() => {
    if (!price && meta.aiSuggestedPrice != null) {
      setPrice(String(meta.aiSuggestedPrice));
    }
  }, [meta.aiSuggestedPrice, price, setPrice]);

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
          placeholder={
            meta.aiSuggestedPrice != null ? `AI 建议 ¥${meta.aiSuggestedPrice}` : "自定义售价"
          }
        />
        {meta.aiSuggestedPrice != null && (
          <p className="text-xs text-muted-foreground">
            AI 参考价 ¥{meta.aiSuggestedPrice}，请由店员确认最终售价
          </p>
        )}
      </div>
    </div>
  );
}

export function useCustomSkuMutation(onDone: (res?: { sku: { id: string; epc: string } }) => void) {
  const fn = useServerFn(createCustomSku);
  return useMutation({
    mutationFn: async (input: {
      meta: SkuMetaState;
      price: string;
      default_shop_ids: string[];
    }) => {
      const { meta, price, default_shop_ids } = input;
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
          attributes: meta.attributes,
          recognition_request_id: meta.recognitionRequestId || null,
          category_confidence: meta.categoryConfidence,
          classification_status: meta.classificationStatus || null,
          ai_suggested_price: meta.aiSuggestedPrice,
          price: Math.round(p * 100) / 100,
          default_shop_ids,
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
  const [smartOpen, setSmartOpen] = useState(false);
  const [defaultShopIds, setDefaultShopIds] = useState<string[]>([]);
  const reset = () => {
    setMeta(emptySkuMeta);
    setPrice("");
    setSmartOpen(false);
    setDefaultShopIds([]);
  };
  const mut = useCustomSkuMutation((res) => {
    reset();
    onOpenChange(false);
    onCreated?.(res);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建自定义商品</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-4">
          {smartOpen ? (
            <SmartSkuCapture
              onApply={(patch) => setMeta((current) => ({ ...current, ...patch }))}
              onClose={() => setSmartOpen(false)}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setSmartOpen(true)}
            >
              <Sparkles className="mr-2 h-4 w-4 text-primary" />
              拍照自动识别分类和商品字段
            </Button>
          )}
          <CustomSkuForm meta={meta} setMeta={setMeta} price={price} setPrice={setPrice} />
          <DefaultShopsSelector value={defaultShopIds} onChange={setDefaultShopIds} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => mut.mutate({ meta, price, default_shop_ids: defaultShopIds })}
            disabled={mut.isPending}
          >
            {mut.isPending ? "创建中…" : "创建并生成 EPC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
