import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { fankuangDefaultForPrice } from "@/lib/commerce/fankuang";

/** 售价下方一行「加入翻筐乐」开关：null 跟随售价（<=49.9 开），点击后成为人工覆盖。 */
export function FankuangSwitch({
  price,
  value,
  onChange,
  disabled,
}: {
  price: string | number;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  disabled?: boolean;
}) {
  const auto = fankuangDefaultForPrice(price);
  const checked = value ?? auto;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label htmlFor="fankuang-switch">加入翻筐乐</Label>
        <p className="text-xs text-muted-foreground">
          {value === null ? "按售价自动（≤49.9 元默认加入）" : "已人工设置"}
          {value !== null && (
            <button
              type="button"
              className="ml-2 underline underline-offset-2"
              onClick={() => onChange(null)}
              disabled={disabled}
            >
              恢复自动
            </button>
          )}
        </p>
      </div>
      <Switch
        id="fankuang-switch"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v)}
      />
    </div>
  );
}
