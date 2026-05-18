import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Save, Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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
import { PageHeader } from "@/components/page-header";
import {
  PARCEL_STATUS_OPTIONS,
  formatJpy,
  formatCny,
  sumTariffJpy,
  computeGrandTotal,
} from "@/lib/japan-parcel.helpers";
import { createJapanParcel, bulkCreateParcelItems } from "@/lib/japan-parcel.functions";
import {
  SmartRecognizePanel,
  type RecognizedResult,
} from "@/components/japan-parcel/smart-recognize-panel";

const ItemImageUploader = lazy(() =>
  import("@/components/japan-parcel/item-image-uploader").then((m) => ({
    default: m.ItemImageUploader,
  })),
);

export const Route = createFileRoute("/purchase/japan-parcel/new")({
  head: () => ({ meta: [{ title: "新建小包裹 · BOOMER OFF" }] }),
  component: NewParcelPage,
});

// ====== Types ======
type Num = number | null;
type Str = string | null;

interface ParcelInfo {
  source_order_no: Str;
  tracking_no: Str;
  status: string;
  status_text: Str;
  total_weight_g: Num;
  volume_cm3: Num;
  max_side_cm: Num;
  storage_days: Num;
  receiver_name: Str;
  receiver_phone: Str;
  receiver_address: Str;
}

interface IntlFee {
  intl_total_jpy: Num;
  intl_exchange_rate: Num;
  intl_pay_method: Str;
  intl_pay_at: Str;
  intl_merchant_order_no: Str;
  intl_freight_jpy: Num;
  intl_ship_method: Str;
  intl_charge_method: Str;
  intl_keep_packaging_jpy: Num;
  intl_reinforce_jpy: Num;
  intl_send_fee_jpy: Num;
  intl_photo_fee_jpy: Num;
  intl_merge_fee_jpy: Num;
  intl_points_used: Num;
}

interface SubItem {
  _key: string;
  sub_order_no: Str;
  item_title: Str;
  item_title_cn: Str;
  item_image_url: Str;
  item_total_jpy: Num;
  item_total_cny: Num;
  unit_price_jpy: Num;
  quantity: Num;
  service_fee_jpy: Num;
  domestic_freight_jpy: Num;
  freight_diff_jpy: Num;
  weight_g: Num;
  exchange_rate: Num;
  pay_method: Str;
  pay_at: Str;
  merchant_order_no: Str;
  tariff_category: Str;
  tariff_rate: Num;
}

const emptyParcel = (): ParcelInfo => ({
  source_order_no: null,
  tracking_no: null,
  status: "purchased",
  status_text: null,
  total_weight_g: null,
  volume_cm3: null,
  max_side_cm: null,
  storage_days: null,
  receiver_name: null,
  receiver_phone: null,
  receiver_address: null,
});
const emptyIntl = (): IntlFee => ({
  intl_total_jpy: null,
  intl_exchange_rate: null,
  intl_pay_method: null,
  intl_pay_at: null,
  intl_merchant_order_no: null,
  intl_freight_jpy: null,
  intl_ship_method: null,
  intl_charge_method: null,
  intl_keep_packaging_jpy: null,
  intl_reinforce_jpy: null,
  intl_send_fee_jpy: null,
  intl_photo_fee_jpy: null,
  intl_merge_fee_jpy: null,
  intl_points_used: null,
});
const emptyItem = (): SubItem => ({
  _key: crypto.randomUUID(),
  sub_order_no: null,
  item_title: null,
  item_title_cn: null,
  item_image_url: null,
  item_total_jpy: null,
  item_total_cny: null,
  unit_price_jpy: null,
  quantity: 1,
  service_fee_jpy: null,
  domestic_freight_jpy: null,
  freight_diff_jpy: null,
  weight_g: null,
  exchange_rate: null,
  pay_method: null,
  pay_at: null,
  merchant_order_no: null,
  tariff_category: null,
  tariff_rate: null,
});

const mergeNonNull = <T,>(target: T, src: Record<string, unknown>): T => ({
  ...(target as object),
  ...Object.fromEntries(Object.entries(src).filter(([, v]) => v != null)),
}) as T;

// ====== Field component ======
function F({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string | number | null;
  onChange: (v: string | number | null) => void;
  type?: "text" | "number" | "datetime";
  placeholder?: string;
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        className="h-9"
        type={type === "number" ? "number" : type === "datetime" ? "datetime-local" : "text"}
        placeholder={placeholder}
        value={
          value == null
            ? ""
            : type === "datetime" && typeof value === "string"
            ? value.slice(0, 16)
            : (value as string | number)
        }
        onChange={(e) => {
          const raw = e.target.value;
          if (type === "number") onChange(raw === "" ? null : Number(raw));
          else if (type === "datetime") onChange(raw ? new Date(raw).toISOString() : null);
          else onChange(raw || null);
        }}
      />
    </div>
  );
}

// ====== Page ======
function NewParcelPage() {
  const nav = useNavigate();
  const create = useServerFn(createJapanParcel);
  const bulkItems = useServerFn(bulkCreateParcelItems);

  const [parcel, setParcel] = useState<ParcelInfo>(emptyParcel());
  const [intl, setIntl] = useState<IntlFee>(emptyIntl());
  const [items, setItems] = useState<SubItem[]>([emptyItem()]);
  const [usedAi, setUsedAi] = useState(false);
  const [smartOpen, setSmartOpen] = useState(false);

  const handleRecognized = (r: RecognizedResult) => {
    if (Object.keys(r.parcel).length) setParcel((p) => mergeNonNull(p, r.parcel));
    if (r.intl) setIntl((i) => mergeNonNull(i, r.intl!));
    if (r.items.length) {
      setItems(r.items.map((it) => mergeNonNull(emptyItem(), it) as SubItem));
    }
    setUsedAi(true);
  };

  // ====== Totals ======
  const totals = useMemo(() => {
    const itemsTotalJpy = items.reduce((s, it) => s + (Number(it.item_total_jpy) || 0), 0);
    const intlTotalJpy = Number(intl.intl_total_jpy) || 0;
    const tariffJpy = sumTariffJpy(items);
    const rate = Number(intl.intl_exchange_rate) || 0;
    const { jpy: grandJpy, cny: grandCny, tariffCny } = computeGrandTotal({
      itemsTotalJpy,
      intlTotalJpy,
      tariffJpy,
      exchangeRate: rate,
    });
    return {
      itemsTotalJpy,
      intlTotalJpy,
      tariffJpy,
      grandJpy,
      grandCny: grandCny ?? 0,
      tariffCny: tariffCny ?? 0,
    };
  }, [items, intl.intl_total_jpy, intl.intl_exchange_rate]);

  // ====== Save ======
  const saveMut = useMutation({
    mutationFn: async (_vars: { continueAdding: boolean }) => {
      const r = await create({
        data: {
          source: usedAi ? "ai_ocr" : "manual",
          ...parcel,
          ...intl,
          tariff_jpy: totals.tariffJpy || null,
          tariff_cny: totals.tariffCny || null,
          grand_total_jpy: totals.grandJpy || null,
          grand_total_cny: totals.grandCny || null,
        },
      });
      const parentId = r.row.id;
      const valid = items.filter(
        (it) => it.item_title || it.item_title_cn || it.sub_order_no || it.item_total_jpy,
      );
      if (valid.length) {
        await bulkItems({
          data: {
            items: valid.map((it, idx) => {
              const { _key: _drop, ...rest } = it;
              void _drop;
              return { ...rest, parent_id: parentId, position: idx };
            }),
          },
        });
      }
      return r.row.id;
    },
    onSuccess: (_id, vars) => {
      if (vars.continueAdding) {
        toast.success("已保存,继续添加下一单");
        setParcel(emptyParcel());
        setIntl(emptyIntl());
        setItems([emptyItem()]);
        setUsedAi(false);
        setSmartOpen(false);
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        toast.success("已保存,可在列表中继续编辑");
        nav({ to: "/purchase/japan-parcel" });
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const updateItem = (key: string, patch: Partial<SubItem>) =>
    setItems((arr) => arr.map((it) => (it._key === key ? { ...it, ...patch } : it)));

  // ====== Unsaved-changes guard ======
  const isDirty = useMemo(() => {
    const stripKey = (arr: SubItem[]) => arr.map(({ _key: _k, ...rest }) => rest);
    const baseline = JSON.stringify({
      parcel: emptyParcel(),
      intl: emptyIntl(),
      items: stripKey([emptyItem()]),
    });
    const current = JSON.stringify({
      parcel,
      intl,
      items: stripKey(items),
    });
    return current !== baseline;
  }, [parcel, intl, items]);

  const shouldBlock = isDirty && !saveMut.isPending && !saveMut.isSuccess;

  const { status, proceed, reset } = useBlocker({
    shouldBlockFn: () => shouldBlock,
    withResolver: true,
    enableBeforeUnload: shouldBlock,
  });

  useEffect(() => {
    if (!shouldBlock) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [shouldBlock]);


  return (
    <div className="space-y-5 pb-10">
      <PageHeader
        title="新建小包裹订单"
        description="智能填充 + 三段式表单，一次保存包裹与所有子订单"
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/purchase/japan-parcel" preload="intent">
                <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> 返回
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => saveMut.mutate({ continueAdding: true })}
              disabled={saveMut.isPending}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {saveMut.isPending ? "保存中…" : "保存并继续添加"}
            </Button>
            <Button
              size="sm"
              className="bg-gradient-brand hover:opacity-90"
              onClick={() => saveMut.mutate({ continueAdding: false })}
              disabled={saveMut.isPending}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {saveMut.isPending ? "保存中…" : "保存"}
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-12">
        {/* === Left main column === */}
        <div className="space-y-5 lg:col-span-8">
          {/* Smart fill */}
          {smartOpen ? (
            <SmartRecognizePanel onApply={handleRecognized} />
          ) : (
            <Card
              className="cursor-pointer border-primary/20 bg-gradient-to-br from-primary/5 to-transparent shadow-card transition hover:border-primary/40"
              onClick={() => setSmartOpen(true)}
            >
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <div className="text-sm font-semibold">✨ 智能识别填充</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    粘贴文字或截图，一键自动填表（点击展开）
                  </div>
                </div>
                <Button size="sm" variant="outline">展开</Button>
              </CardContent>
            </Card>
          )}

          {/* 1. 订单信息 */}
          <Card className="border-border/60 shadow-card">
            <CardHeader className="py-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <span className="h-4 w-1 rounded-full bg-gradient-brand" /> ① 包裹信息
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <F label="订单号" value={parcel.source_order_no} onChange={(v) => setParcel({ ...parcel, source_order_no: v as Str })} />
              <F label="国际物流单号" value={parcel.tracking_no} onChange={(v) => setParcel({ ...parcel, tracking_no: v as Str })} />
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">状态</Label>
                <Select value={parcel.status} onValueChange={(v) => setParcel({ ...parcel, status: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PARCEL_STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <F label="重量（含包装，g）" type="number" value={parcel.total_weight_g} onChange={(v) => setParcel({ ...parcel, total_weight_g: v as Num })} />
              <F label="体积 (cm³)" type="number" value={parcel.volume_cm3} onChange={(v) => setParcel({ ...parcel, volume_cm3: v as Num })} />
              <F label="最大边长 (cm)" type="number" value={parcel.max_side_cm} onChange={(v) => setParcel({ ...parcel, max_side_cm: v as Num })} />
              <F label="存储天数" type="number" value={parcel.storage_days} onChange={(v) => setParcel({ ...parcel, storage_days: v as Num })} />
              <F label="状态文字（原始）" value={parcel.status_text} onChange={(v) => setParcel({ ...parcel, status_text: v as Str })} />
              <div />
              <F label="收货人" value={parcel.receiver_name} onChange={(v) => setParcel({ ...parcel, receiver_name: v as Str })} />
              <F label="电话" value={parcel.receiver_phone} onChange={(v) => setParcel({ ...parcel, receiver_phone: v as Str })} />
              <div className="md:col-span-3">
                <Label className="text-xs text-muted-foreground">收货地址</Label>
                <Textarea
                  rows={2}
                  value={parcel.receiver_address ?? ""}
                  onChange={(e) => setParcel({ ...parcel, receiver_address: e.target.value || null })}
                />
              </div>
            </CardContent>
          </Card>

          {/* 2. 国际物流费用明细 */}
          <Card className="border-border/60 shadow-card">
            <CardHeader className="py-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <span className="h-4 w-1 rounded-full bg-gradient-brand" /> ② 国际物流费用明细
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <F label="国际物流总计（JPY）" type="number" value={intl.intl_total_jpy} onChange={(v) => setIntl({ ...intl, intl_total_jpy: v as Num })} />
              <F label="结算汇率（1 JPY = ? CNY）" type="number" value={intl.intl_exchange_rate} onChange={(v) => setIntl({ ...intl, intl_exchange_rate: v as Num })} placeholder="如 0.0481" />
              <F label="商户订单号" value={intl.intl_merchant_order_no} onChange={(v) => setIntl({ ...intl, intl_merchant_order_no: v as Str })} />
              <F label="支付方式" value={intl.intl_pay_method} onChange={(v) => setIntl({ ...intl, intl_pay_method: v as Str })} />
              <F label="支付时间" type="datetime" value={intl.intl_pay_at} onChange={(v) => setIntl({ ...intl, intl_pay_at: v as Str })} />
              <F label="国际物流费（JPY）" type="number" value={intl.intl_freight_jpy} onChange={(v) => setIntl({ ...intl, intl_freight_jpy: v as Num })} />
              <F label="发送方式" value={intl.intl_ship_method} onChange={(v) => setIntl({ ...intl, intl_ship_method: v as Str })} placeholder="日本邮政 海运件" />
              <F label="收费方式" value={intl.intl_charge_method} onChange={(v) => setIntl({ ...intl, intl_charge_method: v as Str })} placeholder="按重量收费 18,500g" />
              <F label="保留原始包装（JPY）" type="number" value={intl.intl_keep_packaging_jpy} onChange={(v) => setIntl({ ...intl, intl_keep_packaging_jpy: v as Num })} />
              <F label="强化加固（JPY）" type="number" value={intl.intl_reinforce_jpy} onChange={(v) => setIntl({ ...intl, intl_reinforce_jpy: v as Num })} />
              <F label="发送手续费（JPY）" type="number" value={intl.intl_send_fee_jpy} onChange={(v) => setIntl({ ...intl, intl_send_fee_jpy: v as Num })} />
              <F label="拍照费（JPY）" type="number" value={intl.intl_photo_fee_jpy} onChange={(v) => setIntl({ ...intl, intl_photo_fee_jpy: v as Num })} />
              <F label="合单手续费（JPY）" type="number" value={intl.intl_merge_fee_jpy} onChange={(v) => setIntl({ ...intl, intl_merge_fee_jpy: v as Num })} />
              <F label="已使用积分" type="number" value={intl.intl_points_used} onChange={(v) => setIntl({ ...intl, intl_points_used: v as Num })} />
            </CardContent>
          </Card>

          {/* 3. 子订单 */}
          <Card className="border-border/60 shadow-card">
            <CardHeader className="flex flex-row items-center justify-between py-3">
              <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                <span className="h-4 w-1 rounded-full bg-gradient-brand" />
                ③ 子订单 / 包裹内物品（{items.length} 件）
              </CardTitle>
              <Button size="sm" variant="outline" onClick={() => setItems([...items, emptyItem()])}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> 新增子订单
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {items.map((it, idx) => (
                <div key={it._key} className="rounded-lg border border-border/60 bg-muted/20 p-4 transition-colors hover:bg-muted/30">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{idx + 1}</span>
                      子订单 #{idx + 1}
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => setItems((arr) => arr.filter((x) => x._key !== it._key))}
                      disabled={items.length === 1}
                      aria-label="删除"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex gap-3">
                    <Suspense fallback={<div className="h-28 w-28 flex-shrink-0 rounded-md border border-dashed bg-muted/30" />}>
                      <ItemImageUploader
                        value={it.item_image_url}
                        onChange={(url) => updateItem(it._key, { item_image_url: url })}
                      />
                    </Suspense>
                    <div className="grid flex-1 gap-3 md:grid-cols-3">
                      <F label="商品标题（日）" value={it.item_title} onChange={(v) => updateItem(it._key, { item_title: v as Str })} />
                      <F label="商品标题（中）" value={it.item_title_cn} onChange={(v) => updateItem(it._key, { item_title_cn: v as Str })} />
                      <F label="商品费用 JPY" type="number" value={it.item_total_jpy} onChange={(v) => updateItem(it._key, { item_total_jpy: v as Num })} />
                      <F label="≈ CNY" type="number" value={it.item_total_cny} onChange={(v) => updateItem(it._key, { item_total_cny: v as Num })} />
                      <F label="结算汇率" type="number" value={it.exchange_rate} onChange={(v) => updateItem(it._key, { exchange_rate: v as Num })} />
                      <F label="订单编号" value={it.sub_order_no} onChange={(v) => updateItem(it._key, { sub_order_no: v as Str })} />
                      <F label="商户订单号" value={it.merchant_order_no} onChange={(v) => updateItem(it._key, { merchant_order_no: v as Str })} />
                      <F label="入库重量（g）" type="number" value={it.weight_g} onChange={(v) => updateItem(it._key, { weight_g: v as Num })} />
                      <F label="商品价格（JPY）" type="number" value={it.unit_price_jpy} onChange={(v) => updateItem(it._key, { unit_price_jpy: v as Num })} />
                      <F label="数量" type="number" value={it.quantity} onChange={(v) => updateItem(it._key, { quantity: v as Num })} />
                      <F label="手续费（JPY）" type="number" value={it.service_fee_jpy} onChange={(v) => updateItem(it._key, { service_fee_jpy: v as Num })} />
                      <F label="日本国内运费（JPY）" type="number" value={it.domestic_freight_jpy} onChange={(v) => updateItem(it._key, { domestic_freight_jpy: v as Num })} />
                      <F label="运费补差（JPY）" type="number" value={it.freight_diff_jpy} onChange={(v) => updateItem(it._key, { freight_diff_jpy: v as Num })} />
                      <F label="支付方式" value={it.pay_method} onChange={(v) => updateItem(it._key, { pay_method: v as Str })} />
                      <F label="支付时间" type="datetime" value={it.pay_at} onChange={(v) => updateItem(it._key, { pay_at: v as Str })} />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* === Right sidebar (sticky totals) === */}
        <div className="lg:col-span-4">
          <div className="sticky top-4 space-y-4">
            <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent shadow-elegant">
              <CardHeader className="py-3">
                <CardTitle className="text-sm font-semibold">实时合计</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">商品 ({items.length})</span>
                    <span className="font-mono tabular-nums">{formatJpy(totals.itemsTotalJpy)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">+ 国际物流</span>
                    <span className="font-mono tabular-nums">{formatJpy(totals.intlTotalJpy)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border/60 pt-2 font-medium">
                    <span>= 日本侧 (JPY)</span>
                    <span className="font-mono tabular-nums">{formatJpy(totals.grandJpy)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">+ 关税 (CNY)</span>
                    <span className="font-mono tabular-nums">
                      {totals.tariffCny > 0 ? formatCny(totals.tariffCny) : "—"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
                    <span className="text-xs text-muted-foreground">合计应付</span>
                    <span className="font-mono text-2xl font-semibold tabular-nums">
                      {totals.grandCny > 0
                        ? formatCny(totals.grandCny)
                        : formatJpy(totals.grandJpy)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Button
              size="lg"
              className="w-full bg-gradient-brand shadow-elegant hover:opacity-90"
              onClick={() => saveMut.mutate({ continueAdding: false })}
              disabled={saveMut.isPending}
            >
              <Save className="mr-2 h-4 w-4" />
              {saveMut.isPending ? "保存中…" : "保存包裹"}
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={status === "blocked"} onOpenChange={(o) => { if (!o) reset(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃当前修改？</AlertDialogTitle>
            <AlertDialogDescription>
              你在这一单里录入的内容还没有保存，离开后将会丢失。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => reset()}>继续编辑</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => proceed()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              放弃并离开
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
