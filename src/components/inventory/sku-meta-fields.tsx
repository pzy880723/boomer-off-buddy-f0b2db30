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
import { useCategories } from "@/hooks/use-categories";
import { SkuImagePicker } from "./sku-image-picker";

export type SkuGrade = "N" | "S" | "A" | "B" | "C" | "J";

export const SKU_GRADE_OPTIONS: { value: SkuGrade; label: string; desc: string }[] = [
  { value: "N", label: "N 级", desc: "全新 / 未拆封" },
  { value: "S", label: "S 级", desc: "已拆封，功能完好，外观无明显瑕疵" },
  { value: "A", label: "A 级", desc: "功能完好，外观有轻微使用痕迹" },
  { value: "B", label: "B 级", desc: "功能完好，外观有明显痕迹或轻微缺陷" },
  { value: "C", label: "C 级", desc: "功能完好，外观严重瑕疵，但不影响使用" },
  { value: "J", label: "J 级", desc: "缺件 / 当垃圾处理，功能未知" },
];

export type SkuMetaState = {
  category: string;
  name: string;
  sku_code: string;
  weight: string;
  imageUrl: string;
  notes: string;
  grade: string;
};

export const emptySkuMeta: SkuMetaState = {
  category: "",
  name: "",
  sku_code: "",
  weight: "",
  imageUrl: "",
  notes: "",
  grade: "",
};

export function SkuMetaFields({
  state,
  onChange,
  mobile,
  /** 隐藏类目（用于已固定类目场景） */
  hideCategory,
  /** 隐藏商品评级（标准商品场景不用） */
  hideGrade,
  /** 隐藏单件重量（标准商品场景不用） */
  hideWeight,
}: {
  state: SkuMetaState;
  onChange: (next: SkuMetaState) => void;
  mobile?: boolean;
  hideCategory?: boolean;
  hideGrade?: boolean;
  hideWeight?: boolean;
}) {
  const { active: categories, labelOf } = useCategories();
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

      <div className={hideWeight ? "" : "grid grid-cols-2 gap-3"}>
        <div className="space-y-1.5">
          <Label>商品编码</Label>
          <Input
            value={state.sku_code}
            onChange={(e) => patch({ sku_code: e.target.value })}
            placeholder="留空则自动生成"
          />
        </div>
        {!hideWeight && (
          <div className="space-y-1.5">
            <Label>单件重量 (g)（选填）</Label>
            <Input
              type="number"
              value={state.weight}
              onChange={(e) => patch({ weight: e.target.value })}
            />
          </div>
        )}
      </div>

      {!hideGrade && (
        <div className="space-y-1.5">
          <Label>商品评级</Label>
          <Select value={state.grade} onValueChange={(v) => patch({ grade: v })}>
            <SelectTrigger>
              <SelectValue placeholder="选择成色档次" />
            </SelectTrigger>
            <SelectContent>
              {SKU_GRADE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="font-medium">{o.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{o.desc}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}


      <div className="space-y-1.5">
        <Label>商品图片</Label>
        <SkuImagePicker
          value={state.imageUrl}
          onChange={(url) => patch({ imageUrl: url })}
          mobile={mobile}
          defaultName={state.name}
          defaultCategoryLabel={state.category ? CATEGORY_LABEL[state.category] : undefined}
        />
      </div>

      <div className="space-y-1.5">
        <Label>备注 / 描述</Label>
        <Textarea
          value={state.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          rows={3}
          placeholder="商品简介、卖点、注意事项等"
        />
      </div>
    </div>
  );
}
