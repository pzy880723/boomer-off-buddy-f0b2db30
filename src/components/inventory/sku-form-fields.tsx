import { useRef, useState } from "react";
import { Upload, X, Loader2, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { INV_CATEGORIES, PRICE_TIERS, SKU_KIND_LABEL } from "@/lib/inventory.helpers";
import { uploadSkuImage } from "@/lib/image-upload";

export type SkuFormState = {
  category: string;
  priceMode: "tier" | "custom";
  priceTier: string;
  customPrice: string;
  name: string;
  kind: "single" | "pack";
  packPieces: string;
  weight: string;
  imageUrl: string;
  notes: string;
};

export const emptySkuForm: SkuFormState = {
  category: "",
  priceMode: "tier",
  priceTier: "",
  customPrice: "",
  name: "",
  kind: "single",
  packPieces: "",
  weight: "",
  imageUrl: "",
  notes: "",
};

export function resolveSkuFormPrice(s: SkuFormState): number | null {
  if (s.priceMode === "tier") {
    const n = Number(s.priceTier);
    return n > 0 ? n : null;
  }
  const n = Number(s.customPrice);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function SkuFormFields({
  state,
  onChange,
  /** 移动端启用相机 */
  mobile,
}: {
  state: SkuFormState;
  onChange: (next: SkuFormState) => void;
  mobile?: boolean;
}) {
  const patch = (p: Partial<SkuFormState>) => onChange({ ...state, ...p });
  return (
    <div className="grid gap-3">
      <div className="space-y-1.5">
        <Label>类目 *</Label>
        <Select value={state.category} onValueChange={(v) => patch({ category: v })}>
          <SelectTrigger>
            <SelectValue placeholder="选择类目" />
          </SelectTrigger>
          <SelectContent>
            {INV_CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>定价方式 *</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={state.priceMode === "tier" ? "default" : "outline"}
            className="flex-1"
            onClick={() => patch({ priceMode: "tier", customPrice: "" })}
          >
            标准价格档
          </Button>
          <Button
            type="button"
            size="sm"
            variant={state.priceMode === "custom" ? "default" : "outline"}
            className="flex-1"
            onClick={() => patch({ priceMode: "custom", priceTier: "" })}
          >
            自定义价格
          </Button>
        </div>
        {state.priceMode === "tier" ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {PRICE_TIERS.map((t) => {
              const active = String(t) === state.priceTier;
              return (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => patch({ priceTier: String(t) })}
                >
                  ¥{t}
                </Button>
              );
            })}
          </div>
        ) : (
          <div className="relative pt-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 pt-1 text-sm text-muted-foreground">
              ¥
            </span>
            <Input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="自定义售价"
              value={state.customPrice}
              onChange={(e) => patch({ customPrice: e.target.value })}
              className="pl-7"
            />
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>品名 *</Label>
        <Input
          value={state.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="如：奥特曼软胶"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>类型 *</Label>
          <Select
            value={state.kind}
            onValueChange={(v) => patch({ kind: v as "single" | "pack" })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">{SKU_KIND_LABEL.single}</SelectItem>
              <SelectItem value="pack">{SKU_KIND_LABEL.pack}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {state.kind === "pack" && (
          <div className="space-y-1.5">
            <Label>组包件数 *</Label>
            <Input
              type="number"
              value={state.packPieces}
              onChange={(e) => patch({ packPieces: e.target.value })}
              placeholder="如 10"
            />
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label>单件重量 (g)</Label>
        <Input
          type="number"
          value={state.weight}
          onChange={(e) => patch({ weight: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label>商品图片</Label>
        <SkuImagePicker
          value={state.imageUrl}
          onChange={(url) => patch({ imageUrl: url })}
          mobile={mobile}
        />
      </div>

      <div className="space-y-1.5">
        <Label>备注</Label>
        <Textarea
          value={state.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          rows={2}
        />
      </div>
    </div>
  );
}

function SkuImagePicker({
  value,
  onChange,
  mobile,
}: {
  value: string;
  onChange: (url: string) => void;
  mobile?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const url = await uploadSkuImage(file);
      onChange(url);
    } catch (e) {
      toast.error((e as Error).message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  if (value) {
    return (
      <div className="relative h-32 w-32 overflow-hidden rounded-lg border bg-muted">
        <img src={value} alt="" className="h-full w-full object-cover" />
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background"
          aria-label="移除图片"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      disabled={uploading}
      className="flex h-32 w-32 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed bg-muted/30 text-xs text-muted-foreground transition hover:bg-muted/60 disabled:opacity-60"
    >
      {uploading ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin" />
          上传中…
        </>
      ) : (
        <>
          <ImageIcon className="h-5 w-5" />
          <span className="inline-flex items-center gap-1">
            <Upload className="h-3 w-3" /> 上传图片
          </span>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={mobile ? "environment" : undefined}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) handleFile(f);
        }}
      />
    </button>
  );
}
