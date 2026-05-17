import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteJapanParcel,
  deleteParcelItem,
  getJapanParcel,
  updateJapanParcel,
  updateJapanParcelStatus,
  updateParcelItem,
} from "@/lib/japan-parcel.functions";
import { classifyItemsTariff } from "@/lib/tariff.functions";
import {
  PARCEL_STATUS_OPTIONS,
  sumTariffJpy,
  computeItemTariffJpy,
} from "@/lib/japan-parcel.helpers";
import { TARIFF_CATEGORIES, tariffCategoryLabel, rateToPercent, getTariffCategory } from "@/lib/tariff";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ParcelFormValue } from "@/components/parcel-form";
import { ParcelEditSections } from "./parcel-edit-sections";
import { ClickableThumb } from "./image-lightbox";

type ItemRow = {
  id: string;
  sub_order_no: string | null;
  merchant_order_no: string | null;
  source_platform: string | null;
  condition: string | null;
  addon_service: string | null;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
  unit_price_jpy: number | null;
  item_price_jpy: number | null;
  quantity: number | null;
  item_total_jpy: number | null;
  item_total_cny: number | null;
  exchange_rate: number | null;
  service_fee_jpy: number | null;
  domestic_freight_jpy: number | null;
  freight_diff_jpy: number | null;
  weight_g: number | null;
  pay_method: string | null;
  pay_at: string | null;
  notes: string | null;
  tariff_category: string | null;
  tariff_rate: number | null;
};

const EXCLUDED_KEYS = new Set([
  "raw_payload",
  "completeness",
  "created_at",
  "updated_at",
  "account_id",
  "status_timeline",
]);

export function ParcelEditPanel({
  parcelId,
  onDeleted,
  compact = false,
}: {
  parcelId: string;
  onDeleted?: () => void;
  /** 弹窗内 vs 详情页：当前两者展示一致，参数保留兼容 */
  compact?: boolean;
}) {
  const id = parcelId;
  const nav = useNavigate();
  const qc = useQueryClient();
  const get = useServerFn(getJapanParcel);
  const update = useServerFn(updateJapanParcel);
  const del = useServerFn(deleteJapanParcel);
  const setStatus = useServerFn(updateJapanParcelStatus);
  const updateItem = useServerFn(updateParcelItem);
  const delItem = useServerFn(deleteParcelItem);

  const [editingItem, setEditingItem] = useState<ItemRow | null>(null);

  const itemSaveMut = useMutation({
    mutationFn: (it: ItemRow) =>
      updateItem({
        data: {
          id: it.id,
          sub_order_no: it.sub_order_no,
          merchant_order_no: it.merchant_order_no,
          source_platform: it.source_platform,
          condition: it.condition,
          addon_service: it.addon_service,
          item_title: it.item_title,
          item_title_cn: it.item_title_cn,
          item_image_url: it.item_image_url,
          unit_price_jpy: it.unit_price_jpy,
          item_price_jpy: it.item_price_jpy,
          quantity: it.quantity,
          item_total_jpy: it.item_total_jpy,
          item_total_cny: it.item_total_cny,
          exchange_rate: it.exchange_rate,
          service_fee_jpy: it.service_fee_jpy,
          domestic_freight_jpy: it.domestic_freight_jpy,
          freight_diff_jpy: it.freight_diff_jpy,
          weight_g: it.weight_g,
          pay_method: it.pay_method,
          pay_at: it.pay_at,
          notes: it.notes,
          tariff_category: it.tariff_category,
          tariff_rate: it.tariff_rate,
        },
      }),
    onSuccess: () => {
      toast.success("子订单已更新");
      setEditingItem(null);
      qc.invalidateQueries({ queryKey: ["jp-parcel", id] });
      qc.invalidateQueries({ queryKey: ["jp-parcels"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const itemDelMut = useMutation({
    mutationFn: (itemId: string) => delItem({ data: { id: itemId } }),
    onSuccess: () => {
      toast.success("已删除子订单");
      qc.invalidateQueries({ queryKey: ["jp-parcel", id] });
      qc.invalidateQueries({ queryKey: ["jp-parcels"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const q = useQuery({
    queryKey: ["jp-parcel", id],
    queryFn: () => get({ data: { id } }),
  });

  const [form, setForm] = useState<ParcelFormValue>({});
  useEffect(() => {
    if (q.data?.row) {
      const r = q.data.row as Record<string, unknown>;
      const f: ParcelFormValue = {};
      Object.entries(r).forEach(([k, v]) => {
        if (EXCLUDED_KEYS.has(k)) return;
        if (v === null || typeof v === "string" || typeof v === "number") {
          f[k] = v as string | number | null;
        }
      });
      setForm(f);
    }
  }, [q.data]);

  const items = (q.data?.items ?? []) as ItemRow[];
  const itemsTotalJpy = items.reduce((s, it) => s + (Number(it.item_total_jpy) || 0), 0);
  const tariffJpy = sumTariffJpy(items);
  const timeline =
    (q.data?.row as { status_timeline?: { at?: string | null; text?: string | null }[] } | undefined)
      ?.status_timeline ?? [];

  const classify = useServerFn(classifyItemsTariff);
  const [autoClassified, setAutoClassified] = useState(false);
  useEffect(() => {
    if (autoClassified) return;
    if (!q.data) return;
    const missing = items.filter(
      (it) => it.tariff_rate == null && (it.item_title || it.item_title_cn),
    );
    if (missing.length === 0) return;
    setAutoClassified(true);
    classify({
      data: {
        items: missing.map((it) => ({
          id: it.id,
          item_title: it.item_title,
          item_title_cn: it.item_title_cn,
        })),
        persist: true,
      },
    })
      .then(() => {
        qc.invalidateQueries({ queryKey: ["jp-parcel", id] });
        qc.invalidateQueries({ queryKey: ["jp-parcels"] });
      })
      .catch((e) => toast.error(`关税分类失败：${(e as Error).message}`));
  }, [autoClassified, q.data, items, classify, qc, id]);

  const saveMut = useMutation({
    mutationFn: () => update({ data: { id, ...form } as never }),
    onSuccess: () => {
      toast.success("已保存");
      qc.invalidateQueries({ queryKey: ["jp-parcel", id] });
      qc.invalidateQueries({ queryKey: ["jp-parcels"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const delMut = useMutation({
    mutationFn: () => del({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      if (onDeleted) onDeleted();
      else nav({ to: "/purchase/japan-parcel" });
    },
  });

  const statusMut = useMutation({
    mutationFn: (status: string) => setStatus({ data: { id, status } }),
    onSuccess: () => {
      toast.success("状态已更新");
      qc.invalidateQueries({ queryKey: ["jp-parcel", id] });
      qc.invalidateQueries({ queryKey: ["jp-parcels"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (q.isLoading)
    return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>;
  const row = q.data?.row;
  if (!row) return <div className="p-10 text-center">未找到</div>;

  const itemsSlot = (
    <div className="space-y-2">
      {items.length === 0 && (
        <div className="py-4 text-center text-xs text-muted-foreground">此包裹暂无子订单</div>
      )}
      {items.map((it, idx) => (
        <div key={it.id} className="flex gap-3 rounded-lg border border-border/60 bg-card p-3 shadow-card transition-shadow hover:shadow-card-hover">
          {it.item_image_url ? (
            <ClickableThumb
              src={it.item_image_url}
              thumbWidth={200}
              className="h-[72px] w-[72px] flex-shrink-0 rounded-md object-cover ring-1 ring-border"
            />
          ) : (
            <div className="h-[72px] w-[72px] flex-shrink-0 rounded-md bg-muted" />
          )}
          <div className="min-w-0 flex-1 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-muted-foreground">
                #{idx + 1} · {it.sub_order_no || "无单号"}
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono">
                  {it.item_total_jpy != null
                    ? `JPY ${Number(it.item_total_jpy).toLocaleString()}`
                    : "—"}
                  {it.item_total_cny != null
                    ? ` (≈RMB ${Number(it.item_total_cny).toLocaleString()})`
                    : ""}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => setEditingItem(it)}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-destructive"
                  onClick={() => {
                    if (confirm("删除此子订单？")) itemDelMut.mutate(it.id);
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
            <div className="mt-1 truncate text-sm font-medium">
              {it.item_title_cn || it.item_title || "(未命名)"}
            </div>
            {it.item_title_cn && it.item_title && (
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {it.item_title}
              </div>
            )}
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>单价 {it.unit_price_jpy != null ? `JPY ${Number(it.unit_price_jpy).toLocaleString()}` : "—"}</span>
              <span>× {it.quantity ?? "—"}</span>
              <span>重 {it.weight_g ?? "—"}g</span>
              <span>汇率 {it.exchange_rate ?? "—"}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>手续费 {it.service_fee_jpy != null ? `JPY ${Number(it.service_fee_jpy).toLocaleString()}` : "—"}</span>
              <span>国内运费 {it.domestic_freight_jpy != null ? `JPY ${Number(it.domestic_freight_jpy).toLocaleString()}` : "—"}</span>
              <span>补差 {it.freight_diff_jpy != null ? `JPY ${Number(it.freight_diff_jpy).toLocaleString()}` : "—"}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>支付 {it.pay_method || "—"}</span>
              <span>时间 {it.pay_at ? new Date(it.pay_at).toLocaleString() : "—"}</span>
              <span>商户单号 {it.merchant_order_no || "—"}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              <span>类目 {tariffCategoryLabel(it.tariff_category)}</span>
              <span>税率 {rateToPercent(it.tariff_rate)}</span>
              <span>
                关税 ≈ {it.tariff_rate ? `JPY ${computeItemTariffJpy(it).toLocaleString()}` : "—"}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const isDelivered = row.status === "delivered";
  const nextStatus = isDelivered ? "purchased" : "delivered";
  const nextStatusLabel = isDelivered ? "撤销签收" : "确认签收";
  const currentLabel =
    PARCEL_STATUS_OPTIONS.find((s) => s.value === row.status)?.label ?? row.status;

  return (
    <div className="space-y-4">
      <Card className="border-border/60 shadow-card">
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">当前状态</span>
            {isDelivered ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
                {currentLabel}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                {currentLabel}
              </span>
            )}
            <Button
              size="sm"
              variant={isDelivered ? "ghost" : "default"}
              className={isDelivered ? "h-7 text-xs" : "h-7 bg-success text-success-foreground hover:bg-success/90 text-xs"}
              disabled={statusMut.isPending}
              onClick={() => statusMut.mutate(nextStatus)}
            >
              {nextStatusLabel}
            </Button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (confirm("删除此订单？")) delMut.mutate();
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5 text-destructive" /> 删除
            </Button>
            <Button
              size="sm"
              className="bg-gradient-brand hover:opacity-90"
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" /> {saveMut.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ParcelEditSections
        value={form}
        onChange={setForm}
        itemsTotalJpy={itemsTotalJpy}
        itemsSlot={itemsSlot}
        tariffJpy={tariffJpy}
      />

      {timeline.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h3 className="mb-3 text-sm font-semibold">状态时间线</h3>
            <ul className="space-y-1.5 text-xs">
              {timeline.map((t, i) => (
                <li key={i} className="flex gap-3">
                  <span className="w-40 font-mono text-muted-foreground">{t.at ?? "—"}</span>
                  <span>{t.text ?? "—"}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!editingItem} onOpenChange={(o) => !o && setEditingItem(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑子订单</DialogTitle>
          </DialogHeader>
          {editingItem && (
            <ItemEditForm
              value={editingItem}
              onChange={(v) => setEditingItem(v)}
            />
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditingItem(null)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={itemSaveMut.isPending}
              onClick={() => editingItem && itemSaveMut.mutate(editingItem)}
            >
              {itemSaveMut.isPending ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ItemField({
  label,
  type = "text",
  value,
  onChange,
  colSpan = 1,
}: {
  label: string;
  type?: "text" | "number" | "datetime" | "textarea";
  value: string | number | null;
  onChange: (v: string | number | null) => void;
  colSpan?: 1 | 2;
}) {
  const wrap = colSpan === 2 ? "col-span-2" : "";
  if (type === "textarea") {
    return (
      <div className={wrap}>
        <Label className="text-xs">{label}</Label>
        <textarea
          rows={2}
          className="mt-1 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      </div>
    );
  }
  if (type === "datetime") {
    const local = value ? new Date(value as string).toISOString().slice(0, 16) : "";
    return (
      <div className={wrap}>
        <Label className="text-xs">{label}</Label>
        <Input
          type="datetime-local"
          value={local}
          onChange={(e) =>
            onChange(e.target.value ? new Date(e.target.value).toISOString() : null)
          }
        />
      </div>
    );
  }
  return (
    <div className={wrap}>
      <Label className="text-xs">{label}</Label>
      <Input
        type={type}
        value={(value as string | number) ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (type === "number") onChange(raw === "" ? null : Number(raw));
          else onChange(raw || null);
        }}
      />
    </div>
  );
}

function ItemEditForm({
  value,
  onChange,
}: {
  value: ItemRow;
  onChange: (v: ItemRow) => void;
}) {
  const set = <K extends keyof ItemRow>(k: K, v: ItemRow[K]) =>
    onChange({ ...value, [k]: v });
  return (
    <div className="space-y-4">
      <section>
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">① 商品</h4>
        <div className="grid grid-cols-2 gap-3">
          <ItemField label="商品标题（日）" colSpan={2} value={value.item_title} onChange={(v) => set("item_title", v as string | null)} />
          <ItemField label="商品标题（中）" colSpan={2} value={value.item_title_cn} onChange={(v) => set("item_title_cn", v as string | null)} />
          <ItemField label="商品图 URL" colSpan={2} value={value.item_image_url} onChange={(v) => set("item_image_url", v as string | null)} />
          <ItemField label="平台" value={value.source_platform} onChange={(v) => set("source_platform", v as string | null)} />
          <ItemField label="成色 / 状态" value={value.condition} onChange={(v) => set("condition", v as string | null)} />
          <ItemField label="附加服务" colSpan={2} value={value.addon_service} onChange={(v) => set("addon_service", v as string | null)} />
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">② 价格与汇率</h4>
        <div className="grid grid-cols-2 gap-3">
          <ItemField label="商品价格 JPY" type="number" value={value.unit_price_jpy} onChange={(v) => set("unit_price_jpy", v as number | null)} />
          <ItemField label="数量" type="number" value={value.quantity} onChange={(v) => set("quantity", v as number | null)} />
          <ItemField label="商品费用 JPY" type="number" value={value.item_total_jpy} onChange={(v) => set("item_total_jpy", v as number | null)} />
          <ItemField label="≈ CNY" type="number" value={value.item_total_cny} onChange={(v) => set("item_total_cny", v as number | null)} />
          <ItemField label="结算汇率" type="number" value={value.exchange_rate} onChange={(v) => set("exchange_rate", v as number | null)} />
          <ItemField label="单价（item_price_jpy）" type="number" value={value.item_price_jpy} onChange={(v) => set("item_price_jpy", v as number | null)} />
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">③ 物流与重量</h4>
        <div className="grid grid-cols-2 gap-3">
          <ItemField label="入库重量 g" type="number" value={value.weight_g} onChange={(v) => set("weight_g", v as number | null)} />
          <ItemField label="手续费 JPY" type="number" value={value.service_fee_jpy} onChange={(v) => set("service_fee_jpy", v as number | null)} />
          <ItemField label="日本国内运费 JPY" type="number" value={value.domestic_freight_jpy} onChange={(v) => set("domestic_freight_jpy", v as number | null)} />
          <ItemField label="运费补差 JPY" type="number" value={value.freight_diff_jpy} onChange={(v) => set("freight_diff_jpy", v as number | null)} />
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">④ 关税类目</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">类目（决定税率）</Label>
            <Select
              value={value.tariff_category ?? ""}
              onValueChange={(v) => {
                const cat = getTariffCategory(v);
                onChange({
                  ...value,
                  tariff_category: v || null,
                  tariff_rate: cat?.rate ?? null,
                });
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="未识别" />
              </SelectTrigger>
              <SelectContent>
                {TARIFF_CATEGORIES.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label} · {Math.round(c.rate * 100)}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <ItemField
            label="税率（自动）"
            type="number"
            value={value.tariff_rate}
            onChange={(v) => set("tariff_rate", v as number | null)}
          />
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-xs font-semibold text-muted-foreground">④ 支付与单号</h4>
        <div className="grid grid-cols-2 gap-3">
          <ItemField label="订单编号 sub_order_no" value={value.sub_order_no} onChange={(v) => set("sub_order_no", v as string | null)} />
          <ItemField label="商户订单号" value={value.merchant_order_no} onChange={(v) => set("merchant_order_no", v as string | null)} />
          <ItemField label="支付方式" value={value.pay_method} onChange={(v) => set("pay_method", v as string | null)} />
          <ItemField label="支付时间" type="datetime" value={value.pay_at} onChange={(v) => set("pay_at", v as string | null)} />
          <ItemField label="备注" type="textarea" colSpan={2} value={value.notes} onChange={(v) => set("notes", v as string | null)} />
        </div>
      </section>
    </div>
  );
}
