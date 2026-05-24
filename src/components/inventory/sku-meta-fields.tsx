import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { INV_CATEGORIES } from "@/lib/inventory.helpers";
import { SkuImagePicker } from "./sku-image-picker";

export type SkuMetaState = {
  category: string;
  name: string;
  sku_code: string;
  weight: string;
  imageUrl: string;
  notes: string;
};

export const emptySkuMeta: SkuMetaState = {
  category: "",
  name: "",
  sku_code: "",
  weight: "",
  imageUrl: "",
  notes: "",
};

export function SkuMetaFields({
  state,
  onChange,
  mobile,
  /** 隐藏类目（用于已固定类目场景） */
  hideCategory,
}: {
  state: SkuMetaState;
  onChange: (next: SkuMetaState) => void;
  mobile?: boolean;
  hideCategory?: boolean;
}) {
  const patch = (p: Partial<SkuMetaState>) => onChange({ ...state, ...p });
  return (
    <div className="grid gap-3">
      {!hideCategory && (
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
      )}

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
          <Label>商品编码</Label>
          <Input
            value={state.sku_code}
            onChange={(e) => patch({ sku_code: e.target.value })}
            placeholder="留空则自动生成"
          />
        </div>
        <div className="space-y-1.5">
          <Label>单件重量 (g)（选填）</Label>
          <Input
            type="number"
            value={state.weight}
            onChange={(e) => patch({ weight: e.target.value })}
          />
        </div>
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
