import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type MeasurementFieldState = {
  height_cm: string;
  width_cm: string;
  depth_cm: string;
  diameter_cm: string;
};

export const emptyMeasurementFields: MeasurementFieldState = {
  height_cm: "",
  width_cm: "",
  depth_cm: "",
  diameter_cm: "",
};

export function parseMeasurementFields(state: MeasurementFieldState): {
  ok: true;
  value: { height_cm: number | null; width_cm: number | null; depth_cm: number | null; diameter_cm: number | null };
} | { ok: false; error: string } {
  const value = { height_cm: null, width_cm: null, depth_cm: null, diameter_cm: null } as {
    height_cm: number | null;
    width_cm: number | null;
    depth_cm: number | null;
    diameter_cm: number | null;
  };
  for (const key of ["height_cm", "width_cm", "depth_cm", "diameter_cm"] as const) {
    const raw = state[key].trim();
    if (!raw) continue;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0 || num > 9999.99) {
      return { ok: false, error: "尺寸需为 0–9999.99 之间的数字（cm）" };
    }
    value[key] = Math.round(num * 100) / 100;
  }
  return { ok: true, value };
}

/** 实测尺寸（cm），全部选填；只接受人工实测，不展示 AI 估算。 */
export function MeasurementFields({
  state,
  onChange,
}: {
  state: MeasurementFieldState;
  onChange: (next: MeasurementFieldState) => void;
}) {
  const patch = (p: Partial<MeasurementFieldState>) => onChange({ ...state, ...p });
  const field = (key: keyof MeasurementFieldState, label: string) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        step="0.1"
        min="0"
        value={state[key]}
        onChange={(e) => patch({ [key]: e.target.value })}
        placeholder="未知留空"
      />
    </div>
  );
  return (
    <div className="space-y-1.5">
      <Label>实测尺寸 (cm)（选填）</Label>
      <div className="grid grid-cols-2 gap-3">
        {field("height_cm", "高度")}
        {field("width_cm", "宽度")}
        {field("depth_cm", "深度")}
        {field("diameter_cm", "直径")}
      </div>
      <p className="text-[11px] text-muted-foreground">
        只填人工实测值；未知项留空，不会展示 AI 估算。
      </p>
    </div>
  );
}
