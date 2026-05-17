import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ClickableThumb } from "./image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ImageOff } from "lucide-react";
import {
  simplifyStatus,
  SIMPLE_STATUS_LABEL,
  sumTariffJpy,
  computeItemTariffJpy,
} from "@/lib/japan-parcel.helpers";
import { tariffCategoryLabel, rateToPercent } from "@/lib/tariff";
import { getJapanParcel } from "@/lib/japan-parcel.functions";
import { ParcelOverviewSections } from "./parcel-edit-sections";
import { CurrencyToggle } from "./currency-toggle";
import type { ParcelFormValue } from "@/components/parcel-form";

const ParcelEditPanel = lazy(() =>
  import("./parcel-edit-panel").then((m) => ({ default: m.ParcelEditPanel })),
);

export interface ParcelCardItem {
  id: string;
  sub_order_no?: string | null;
  merchant_order_no?: string | null;
  source_platform?: string | null;
  condition?: string | null;
  addon_service?: string | null;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
  item_total_jpy: number | null;
  item_total_cny: number | null;
  unit_price_jpy?: number | null;
  item_price_jpy?: number | null;
  quantity?: number | null;
  weight_g?: number | null;
  exchange_rate?: number | null;
  service_fee_jpy?: number | null;
  domestic_freight_jpy?: number | null;
  freight_diff_jpy?: number | null;
  pay_method?: string | null;
  pay_at?: string | null;
  notes?: string | null;
  tariff_category?: string | null;
  tariff_rate?: number | null;
}

export interface ParcelCardData {
  id: string;
  source_order_no: string | null;
  tracking_no: string | null;
  status: string;
  purchased_at?: string | null;
  received_at?: string | null;
  grand_total_jpy?: number | null;
  grand_total_cny?: number | null;
  intl_total_jpy?: number | null;
  intl_total_cny?: number | null;
  intl_freight_jpy?: number | null;
  intl_reinforce_jpy?: number | null;
  intl_merge_fee_jpy?: number | null;
  intl_send_fee_jpy?: number | null;
  intl_exchange_rate?: number | null;
  tariff_jpy?: number | null;
}

export function ParcelCardDialog({
  open,
  onOpenChange,
  parcel,
  defaultTab = "overview",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  parcel: ParcelCardData | null;
  /** 不再使用，列表行字段不全；保留兼容 */
  items?: ParcelCardItem[];
  defaultTab?: "overview" | "edit";
}) {
  const [tab, setTab] = useState<string>(defaultTab);
  useEffect(() => {
    if (open) setTab(defaultTab);
  }, [open, defaultTab]);

  const get = useServerFn(getJapanParcel);
  const id = parcel?.id;
  const q = useQuery({
    queryKey: ["jp-parcel", id],
    queryFn: () => get({ data: { id: id! } }),
    enabled: !!id && open,
  });

  if (!parcel) return null;

  const fullRow = (q.data?.row ?? parcel) as unknown as ParcelFormValue;
  const fullItems = (q.data?.items ?? []) as ParcelCardItem[];
  const itemsTotalJpy = fullItems.reduce(
    (s, it) => s + (Number(it.item_total_jpy) || 0),
    0,
  );
  const tariffJpy = sumTariffJpy(fullItems);
  const simple = simplifyStatus(parcel.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>包裹 {parcel.source_order_no || "(无单号)"}</span>
            <Badge variant={simple === "delivered" ? "default" : "secondary"}>
              {SIMPLE_STATUS_LABEL[simple]}
            </Badge>
            {q.isFetching && (
              <span className="text-[10px] text-muted-foreground">加载中…</span>
            )}
            <CurrencyToggle className="ml-auto" />
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab} className="mt-2">
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="edit">编辑</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="pt-3">
            {q.isLoading && !q.data ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                加载中…
              </div>
            ) : (
              <ParcelOverviewSections
                value={fullRow}
                itemsTotalJpy={itemsTotalJpy}
                tariffJpy={tariffJpy}
                itemsSlot={<OverviewItems items={fullItems} />}
              />
            )}
          </TabsContent>

          <TabsContent value="edit" className="pt-3">
            {tab === "edit" && (
              <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">正在加载编辑面板…</div>}>
                <ParcelEditPanel
                  parcelId={parcel.id}
                  compact
                  onDeleted={() => onOpenChange(false)}
                />
              </Suspense>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function OverviewItems({ items }: { items: ParcelCardItem[] }) {
  if (items.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        此包裹暂无子订单
      </div>
    );
  }
  const fmtJpy = (v: number | null | undefined) =>
    v != null ? `JPY ${Number(v).toLocaleString()}` : "—";
  const fmtCny = (v: number | null | undefined) =>
    v != null ? `RMB ${Number(v).toLocaleString()}` : "—";
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((it, idx) => (
        <div key={it.id} className="flex gap-3 rounded-md border p-3">
          {it.item_image_url ? (
            <ClickableThumb
              src={it.item_image_url}
              thumbWidth={200}
              className="h-20 w-20 flex-shrink-0 rounded object-cover"
            />
          ) : (
            <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
              <ImageOff className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1 text-xs">
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">
                #{idx + 1} · {it.sub_order_no || "无单号"}
              </span>
              <span className="text-right font-mono text-[11px]">
                {fmtJpy(it.item_total_jpy)}
                {it.item_total_cny != null && (
                  <span className="ml-1 text-muted-foreground">
                    ≈ {fmtCny(it.item_total_cny)}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-sm font-medium">
              {it.item_title_cn || it.item_title || "(未命名)"}
            </div>
            {it.item_title_cn && it.item_title && (
              <div className="line-clamp-1 text-[10px] text-muted-foreground">
                {it.item_title}
              </div>
            )}

            <Separator />
            <Row label="单价" v={fmtJpy(it.unit_price_jpy)} />
            <Row label="数量" v={it.quantity ?? "—"} />
            <Row label="重量" v={it.weight_g != null ? `${it.weight_g}g` : "—"} />
            <Row label="汇率" v={it.exchange_rate ?? "—"} />

            <Separator />
            <Row label="手续费" v={fmtJpy(it.service_fee_jpy)} />
            <Row label="国内运费" v={fmtJpy(it.domestic_freight_jpy)} />
            <Row label="运费补差" v={fmtJpy(it.freight_diff_jpy)} />

            <Separator />
            <Row label="关税类目" v={tariffCategoryLabel(it.tariff_category)} />
            <Row label="税率" v={rateToPercent(it.tariff_rate)} />
            <Row
              label="关税"
              v={it.tariff_rate ? fmtJpy(computeItemTariffJpy(it)) : "—"}
            />

            <Separator />
            <Row label="支付方式" v={it.pay_method || "—"} />
            <Row
              label="支付时间"
              v={it.pay_at ? new Date(it.pay_at).toLocaleString() : "—"}
            />
            <Row label="商户单号" v={it.merchant_order_no || "—"} />
            {(it.source_platform || it.condition || it.addon_service) && (
              <>
                <Separator />
                {it.source_platform && <Row label="平台" v={it.source_platform} />}
                {it.condition && <Row label="成色" v={it.condition} />}
                {it.addon_service && <Row label="附加服务" v={it.addon_service} />}
              </>
            )}
            {it.notes && (
              <>
                <Separator />
                <div className="mt-1 text-[11px] text-muted-foreground">
                  备注：<span className="text-foreground">{it.notes}</span>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Separator() {
  return <div className="my-1.5 border-t border-dashed" />;
}

function Row({ label, v }: { label: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
