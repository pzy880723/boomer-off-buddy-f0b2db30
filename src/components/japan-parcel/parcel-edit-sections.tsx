import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PARCEL_STATUS_OPTIONS } from "@/lib/japan-parcel.helpers";
import { useCurrencyDisplay } from "@/hooks/use-currency-display";
import type { ParcelFormValue } from "@/components/parcel-form";

type FieldType = "text" | "number" | "datetime" | "textarea" | "select";
interface FieldDef {
  key: string;
  label: string;
  type?: FieldType;
  options?: { value: string; label: string }[];
  colSpan?: 1 | 2 | 3;
}

const PARCEL_INFO: FieldDef[] = [
  { key: "system_code", label: "系统编码" },
  { key: "source_order_no", label: "订单号" },
  { key: "tracking_no", label: "国际物流单号" },
  { key: "intl_merchant_order_no", label: "平台订单号" },
  { key: "purchased_at", label: "采购时间", type: "datetime" },
  { key: "received_at", label: "签收时间", type: "datetime" },
  { key: "created_at", label: "添加时间", type: "datetime" },
  { key: "status", label: "状态", type: "select", options: PARCEL_STATUS_OPTIONS },
  { key: "warehouse_location", label: "仓库位置" },
  { key: "receiver_name", label: "收件人" },
  { key: "receiver_phone", label: "收件电话" },
  { key: "receiver_address", label: "收件地址", colSpan: 3 },
  { key: "notes", label: "备注", type: "textarea", colSpan: 3 },
];

const INTL_FEE: FieldDef[] = [
  { key: "intl_freight_jpy", label: "国际运费 JPY ", type: "number" },
  { key: "intl_reinforce_jpy", label: "加固费 JPY ", type: "number" },
  { key: "intl_merge_fee_jpy", label: "合单费 JPY ", type: "number" },
  { key: "intl_send_fee_jpy", label: "发送费 JPY ", type: "number" },
  { key: "intl_photo_fee_jpy", label: "拍照费 JPY ", type: "number" },
  { key: "intl_keep_packaging_jpy", label: "保留包装 JPY ", type: "number" },
  { key: "intl_points_used", label: "积分抵扣 JPY ", type: "number" },
  { key: "tariff_jpy", label: "关税 JPY ", type: "number" },
  { key: "intl_exchange_rate", label: "汇率", type: "number" },
  { key: "intl_ship_method", label: "运输方式" },
  { key: "intl_charge_method", label: "计费方式" },
  { key: "intl_pay_method", label: "支付方式" },
  { key: "intl_pay_at", label: "支付时间", type: "datetime" },
  { key: "intl_total_jpy", label: "国际物流小计 JPY ", type: "number" },
  { key: "intl_total_cny", label: "国际物流小计 RMB ", type: "number" },
];

const TOTAL_FIELDS: FieldDef[] = [
  { key: "grand_total_jpy", label: "合计 JPY", type: "number" },
  { key: "grand_total_cny", label: "合计 RMB", type: "number" },
];

function num(v: unknown): number {
  return Number(v) || 0;
}

function FieldInput({
  f,
  value,
  onChange,
}: {
  f: FieldDef;
  value: string | number | null | undefined;
  onChange: (v: string | number | null) => void;
}) {
  if (f.type === "textarea") {
    return (
      <Textarea
        rows={2}
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      />
    );
  }
  if (f.type === "select") {
    return (
      <Select value={(value as string) ?? ""} onValueChange={(val) => onChange(val)}>
        <SelectTrigger className="h-9">
          <SelectValue placeholder="—" />
        </SelectTrigger>
        <SelectContent>
          {f.options?.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (f.type === "datetime") {
    const local = value ? new Date(value as string).toISOString().slice(0, 16) : "";
    return (
      <Input
        className="h-9"
        type="datetime-local"
        value={local}
        onChange={(e) =>
          onChange(e.target.value ? new Date(e.target.value).toISOString() : null)
        }
      />
    );
  }
  return (
    <Input
      className="h-9"
      type={f.type === "number" ? "number" : "text"}
      value={(value as string | number) ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        if (f.type === "number") onChange(raw === "" ? null : Number(raw));
        else onChange(raw || null);
      }}
    />
  );
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {right}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function FieldGrid({
  fields,
  value,
  onChange,
}: {
  fields: FieldDef[];
  value: ParcelFormValue;
  onChange: (k: string, v: string | number | null) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {fields.map((f) => (
        <div
          key={f.key}
          className={
            f.colSpan === 3
              ? "grid gap-1.5 sm:col-span-2 lg:col-span-3"
              : f.colSpan === 2
                ? "grid gap-1.5 sm:col-span-2"
                : "grid gap-1.5"
          }
        >
          <Label className="text-xs text-muted-foreground">{f.label}</Label>
          <FieldInput f={f} value={value[f.key]} onChange={(v) => onChange(f.key, v)} />
        </div>
      ))}
    </div>
  );
}

export function ParcelEditSections({
  value,
  onChange,
  itemsTotalJpy,
  itemsSlot,
  tariffJpy = 0,
}: {
  value: ParcelFormValue;
  onChange: (v: ParcelFormValue) => void;
  itemsTotalJpy: number;
  /** 第三段（子订单列表 + 编辑/删除）由 ParcelEditPanel 注入，这里只负责排版 */
  itemsSlot: React.ReactNode;
  /** Σ 子订单关税（JPY，按 tariff_rate 计算） */
  tariffJpy?: number;
}) {
  const set = (k: string, v: string | number | null) => onChange({ ...value, [k]: v });

  const intlTotal = num(value.intl_total_jpy);
  const rate = num(value.intl_exchange_rate);
  // JPY 合计：商品 + 国际物流（关税在国内付，不进 JPY）
  const suggestedJpy = itemsTotalJpy + intlTotal;
  const tariffCny = rate > 0 ? Math.round((tariffJpy * rate) * 100) / 100 : null;
  const suggestedCny =
    rate > 0
      ? Math.round((suggestedJpy * rate + (tariffCny ?? 0)) * 100) / 100
      : null;

  return (
    <div className="space-y-4">
      <Section title="① 包裹信息">
        <FieldGrid fields={PARCEL_INFO} value={value} onChange={set} />
      </Section>

      <Section title="② 国际物流费用明细">
        <FieldGrid fields={INTL_FEE} value={value} onChange={set} />
      </Section>

      <Section title={`③ 子订单信息`}>{itemsSlot}</Section>

      <Section
        title="④ 合计费用"
        right={
          <div className="text-right text-xs text-muted-foreground">
            建议值 JPY {suggestedJpy.toLocaleString()}
            {suggestedCny ? ` ≈ RMB ${suggestedCny.toLocaleString()}` : ""}
            <button
              type="button"
              className="ml-2 text-primary underline-offset-2 hover:underline"
              onClick={() => {
                const next: ParcelFormValue = {
                  ...value,
                  grand_total_jpy: suggestedJpy,
                  tariff_jpy: tariffJpy,
                };
                if (suggestedCny != null) next.grand_total_cny = suggestedCny;
                if (tariffCny != null) next.tariff_cny = tariffCny;
                onChange(next);
              }}
            >
              使用建议值
            </button>
          </div>
        }
      >
        <FieldGrid fields={TOTAL_FIELDS} value={value} onChange={set} />
        <div className="mt-3 grid grid-cols-1 gap-3 rounded-md bg-muted/30 p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-muted-foreground">商品总额</div>
            <div className="mt-0.5 font-mono">JPY {itemsTotalJpy.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-muted-foreground">国际物流小计</div>
            <div className="mt-0.5 font-mono">JPY {intlTotal.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-muted-foreground">日本侧合计 (JPY)</div>
            <div className="mt-0.5 font-mono">JPY {suggestedJpy.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-muted-foreground">关税（按子订单税率，付人民币）</div>
            <div className="mt-0.5 font-mono">
              {tariffCny != null ? `RMB ${tariffCny.toLocaleString()}` : "—"}
              <span className="ml-1 text-[10px] text-muted-foreground">
                (JPY {tariffJpy.toLocaleString()})
              </span>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

/** 只读概览版本：与编辑视图同结构、同字段顺序 */
export function ParcelOverviewSections({
  value,
  itemsTotalJpy,
  itemsSlot,
  tariffJpy = 0,
}: {
  value: ParcelFormValue;
  itemsTotalJpy: number;
  itemsSlot: React.ReactNode;
  tariffJpy?: number;
}) {
  const [currency] = useCurrencyDisplay();
  const intlTotal = num(value.intl_total_jpy);
  const rate = num(value.intl_exchange_rate);
  // 日本侧 JPY 合计 = 商品 + 国际物流（关税不计入 JPY）
  const computedJpy = itemsTotalJpy + intlTotal;
  const grandJpy =
    value.grand_total_jpy != null ? num(value.grand_total_jpy) : computedJpy;
  const tariffCny = rate > 0 ? Math.round((tariffJpy * rate) * 100) / 100 : null;
  const computedCny =
    rate > 0
      ? Math.round((grandJpy * rate + (tariffCny ?? 0)) * 100) / 100
      : null;
  const grandCny =
    value.grand_total_cny != null ? num(value.grand_total_cny) : computedCny;

  return (
    <div className="space-y-4">
      <Section title="① 包裹信息">
        <ReadGrid fields={PARCEL_INFO} value={value} />
      </Section>

      <Section title="② 国际物流费用明细">
        <ReadGrid fields={INTL_FEE} value={value} />
        <div className="mt-3 flex justify-end text-xs">
          <span className="text-muted-foreground">小计：</span>
          <span className="ml-1 font-mono font-medium">
            JPY {intlTotal.toLocaleString()}
            {value.intl_total_cny != null
              ? ` ≈ RMB ${num(value.intl_total_cny).toLocaleString()}`
              : ""}
          </span>
        </div>
      </Section>

      <Section title="③ 子订单信息">
        {itemsSlot}
        <div className="mt-3 flex justify-end text-xs">
          <span className="text-muted-foreground">商品总额：</span>
          <span className="ml-1 font-mono font-medium">JPY {itemsTotalJpy.toLocaleString()}</span>
        </div>
      </Section>

      <Section title="④ 合计费用">
        <div className="space-y-1.5 rounded-md bg-muted/30 p-3 text-xs">
          <Line label="商品总额" v={`JPY ${itemsTotalJpy.toLocaleString()}`} />
          <Line label="+ 国际物流" v={`JPY ${intlTotal.toLocaleString()}`} />
          <Line
            label="= 日本侧合计 (JPY)"
            v={`JPY ${grandJpy.toLocaleString()}`}
            strong
          />
          <Line
            label="+ 关税（按子订单税率，国内付人民币）"
            v={
              tariffCny != null
                ? `RMB ${tariffCny.toLocaleString()}`
                : `JPY ${tariffJpy.toLocaleString()} (缺汇率)`
            }
          />
        </div>
        <div className="mt-3 flex flex-wrap items-baseline justify-end gap-x-6 gap-y-1">
          <span className="text-sm text-muted-foreground">合计</span>
          {currency !== "cny" && (
            <span className="font-mono text-2xl font-semibold">
              JPY {grandJpy.toLocaleString()}
              <span className="ml-1 text-xs text-muted-foreground">JPY</span>
            </span>
          )}
          {currency !== "jpy" && grandCny != null && (
            <span className="font-mono text-2xl font-semibold">
              RMB {grandCny.toLocaleString()}
              <span className="ml-1 text-xs text-muted-foreground">CNY</span>
            </span>
          )}
          {currency === "jpy" && grandCny == null && (
            <span className="text-xs text-muted-foreground">（无汇率）</span>
          )}
        </div>
        {currency === "both" && grandCny != null && (
          <div className="mt-1 text-right font-mono text-[11px] text-muted-foreground">
            日本侧 JPY {grandJpy.toLocaleString()} + 关税{" "}
            {tariffCny != null ? `RMB ${tariffCny.toLocaleString()}` : "—"}
          </div>
        )}
      </Section>
    </div>
  );
}

function Line({
  label,
  v,
  strong,
}: {
  label: string;
  v: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={"font-mono " + (strong ? "font-semibold" : "")}>{v}</span>
    </div>
  );
}

function ReadGrid({ fields, value }: { fields: FieldDef[]; value: ParcelFormValue }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
      {fields.map((f) => {
        const v = value[f.key];
        let display: string = "—";
        if (v != null && v !== "") {
          if (f.type === "datetime") display = new Date(v as string).toLocaleString();
          else if (f.type === "select")
            display = f.options?.find((o) => o.value === v)?.label ?? String(v);
          else if (f.type === "number") display = `${Number(v).toLocaleString()}`;
          else display = String(v);
        }
        return (
          <div key={f.key} className={f.colSpan === 3 ? "sm:col-span-3" : ""}>
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd
              className={
                f.type === "number"
                  ? "mt-0.5 font-mono"
                  : "mt-0.5 break-words"
              }
            >
              {display}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
