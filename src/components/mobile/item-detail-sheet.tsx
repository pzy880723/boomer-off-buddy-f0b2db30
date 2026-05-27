import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { toThumbUrl } from "@/lib/image";
import { tariffCategoryLabel, rateToPercent } from "@/lib/tariff";
import { computeItemTariffJpy, computePiecePrice, computeParcelItemLanded, formatCny } from "@/lib/japan-parcel.helpers";
import { PhotoUploaderGrid } from "@/components/mobile/photo-uploader-grid";
import { PackPriceCalculatorDialog } from "@/components/japan-parcel/pack-price-calculator-dialog";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { updateItemArrivalPhotos, getParcelLandedContext } from "@/lib/mobile.functions";
import { useUserNames } from "@/hooks/use-user-names";
import { toast } from "sonner";

export interface ItemDetailValue {
  id: string;
  sub_order_no?: string | null;
  merchant_order_no?: string | null;
  source_platform?: string | null;
  condition?: string | null;
  addon_service?: string | null;
  item_title?: string | null;
  item_title_cn?: string | null;
  item_image_url?: string | null;
  item_total_jpy?: number | null;
  item_total_cny?: number | null;
  unit_price_jpy?: number | null;
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
  arrival_photo_urls?: string[] | null;
  parent_id?: string | null;
  system_code?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  pack_pieces?: number | null;
  pack_pieces_source?: string | null;
  pack_unit_note?: string | null;
}

const fmtJpy = (v: number | null | undefined) =>
  v != null ? `JPY ${Number(v).toLocaleString()}` : "—";
const fmtCny = (v: number | null | undefined) =>
  v != null ? `RMB ${Number(v).toLocaleString()}` : "—";

export function ItemDetailSheet({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item: ItemDetailValue | null;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(updateItemArrivalPhotos);
  const [photos, setPhotos] = useState<string[]>([]);
  const [calcOpen, setCalcOpen] = useState(false);
  const [packOverride, setPackOverride] = useState<{
    pack_pieces: number | null;
    pack_pieces_source: string | null;
    pack_unit_note: string | null;
  } | null>(null);
  const userNames = useUserNames([item?.created_by]);

  useEffect(() => {
    setPhotos(Array.isArray(item?.arrival_photo_urls) ? item!.arrival_photo_urls! : []);
    setPackOverride(null);
  }, [item?.id, item?.arrival_photo_urls]);

  if (!item) return null;
  const img = item.item_image_url
    ? toThumbUrl(item.item_image_url, 600) ?? item.item_image_url
    : null;

  const handleChange = (urls: string[]) => {
    setPhotos(urls);
    void (async () => {
      try {
        await saveFn({ data: { item_id: item.id, photo_urls: urls } });
        qc.invalidateQueries({ queryKey: ["mobile-parcel"] });
      } catch (e) {
        toast.error((e as Error).message);
      }
    })();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto rounded-t-2xl p-0">

        <SheetHeader className="px-4 pt-4">
          <SheetTitle className="text-left text-base">
            {item.item_title_cn || item.item_title || "(未命名)"}
          </SheetTitle>
        </SheetHeader>
        <div className="space-y-3 p-4 pt-3">
          {img ? (
            <img
              src={img}
              alt=""
              className="max-h-72 w-full rounded-xl border object-contain bg-muted"
            />
          ) : null}

          <div className="rounded-xl border bg-card p-3 text-xs">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="font-mono text-[10px] text-muted-foreground">
                {item.sub_order_no || "无单号"}
              </span>
              <span className="text-right font-mono text-[11px]">
                {fmtJpy(item.item_total_jpy)}
                {item.item_total_cny != null && (
                  <span className="ml-1 text-muted-foreground">
                    ≈ {fmtCny(item.item_total_cny)}
                  </span>
                )}
              </span>
            </div>
            {item.item_title_cn && item.item_title ? (
              <div className="line-clamp-2 text-[11px] text-muted-foreground">
                {item.item_title}
              </div>
            ) : null}

            <Sep />
            <Row label="单价" v={fmtJpy(item.unit_price_jpy)} />
            <Row label="数量" v={item.quantity ?? "—"} />
            <Row label="重量" v={item.weight_g != null ? `${item.weight_g}g` : "—"} />
            <Row label="汇率" v={item.exchange_rate ?? "—"} />

            <Sep />
            <Row label="手续费" v={fmtJpy(item.service_fee_jpy)} />
            <Row label="国内运费" v={fmtJpy(item.domestic_freight_jpy)} />
            <Row label="运费补差" v={fmtJpy(item.freight_diff_jpy)} />

            <Sep />
            <Row label="关税类目" v={tariffCategoryLabel(item.tariff_category)} />
            <Row label="税率" v={rateToPercent(item.tariff_rate)} />
            <Row
              label="关税"
              v={item.tariff_rate ? fmtJpy(computeItemTariffJpy(item)) : "—"}
            />

            <Sep />
            <Row label="支付方式" v={item.pay_method || "—"} />
            <Row
              label="支付时间"
              v={item.pay_at ? new Date(item.pay_at).toLocaleString() : "—"}
            />
            <Row label="商户单号" v={item.merchant_order_no || "—"} />
            {(item.source_platform || item.condition || item.addon_service) ? (
              <>
                <Sep />
                {item.source_platform ? <Row label="平台" v={item.source_platform} /> : null}
                {item.condition ? <Row label="成色" v={item.condition} /> : null}
                {item.addon_service ? <Row label="附加服务" v={item.addon_service} /> : null}
              </>
            ) : null}
            <Sep />
            <Row label="系统编码" v={item.system_code || "—"} />
            <Row label="添加人" v={userNames.name(item.created_by)} />
            <Row label="添加时间" v={item.created_at ? new Date(item.created_at).toLocaleString() : "—"} />
            {item.notes ? (
              <>
                <Sep />
                <div className="mt-1 text-[11px] text-muted-foreground">
                  备注：<span className="text-foreground">{item.notes}</span>
                </div>
              </>
            ) : null}
          </div>

          {(() => {
            const effPieces = packOverride?.pack_pieces ?? item.pack_pieces ?? null;
            const effUnitNote = packOverride?.pack_unit_note ?? item.pack_unit_note ?? null;
            const pp = effPieces;
            const unit = effUnitNote || "个";
            const { pieceCny, pieceJpy } = computePiecePrice(
              item.item_total_jpy ?? null,
              item.item_total_cny ?? null,
              pp && pp > 0 ? pp : null,
            );
            return (
              <div className="rounded-xl border bg-card p-3">
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-xs font-medium flex items-center gap-1">
                    <Sparkles className="h-3.5 w-3.5 text-primary" /> 拆包单价
                  </h4>
                  {pp && pp > 0 ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => setCalcOpen(true)}>
                      重新计算
                    </Button>
                  ) : null}
                </div>
                {pp && pp > 0 ? (
                  <div className="flex items-baseline justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      整包拆 <b className="text-foreground">{pp}</b> {unit}
                    </span>
                    <span className="font-mono tabular-nums text-sm font-semibold text-red-600">
                      {pieceCny != null
                        ? `¥${pieceCny.toFixed(2)}/${unit}`
                        : pieceJpy != null
                          ? `JPY ${pieceJpy.toFixed(0)}/${unit}`
                          : "—"}
                    </span>
                  </div>
                ) : (
                  <Button size="sm" className="w-full" onClick={() => setCalcOpen(true)}>
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" /> 拆包单价计算
                  </Button>
                )}
              </div>
            );
          })()}



          <div className="rounded-xl border bg-card p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <h4 className="text-xs font-medium">到货照片</h4>
              <span className="text-[10px] text-muted-foreground">
                {photos.length}/9 · 支持连拍/多选
              </span>
            </div>
            <PhotoUploaderGrid
              value={photos}
              onChange={handleChange}
              folder="receive"
              parcelId={item.parent_id ?? undefined}
              cols={4}
            />
          </div>
        </div>
      </SheetContent>
      <PackPriceCalculatorDialog
        open={calcOpen}
        onOpenChange={(v) => {
          setCalcOpen(v);
          if (!v) {
            qc.invalidateQueries({ queryKey: ["mobile-parcel"] });
            qc.invalidateQueries({ queryKey: ["mobile-parcels"] });
          }
        }}
        onSaved={(s) => setPackOverride(s)}
        item={{
          id: item.id,
          item_title: item.item_title ?? null,
          item_title_cn: item.item_title_cn ?? null,
          item_image_url: item.item_image_url ?? null,
          item_total_jpy: item.item_total_jpy ?? null,
          pack_pieces: packOverride?.pack_pieces ?? item.pack_pieces ?? null,
          pack_pieces_source: packOverride?.pack_pieces_source ?? item.pack_pieces_source ?? null,
          pack_unit_note: packOverride?.pack_unit_note ?? item.pack_unit_note ?? null,
        }}
        landedCny={item.item_total_cny ?? null}
      />
    </Sheet>
  );
}

function Sep() {
  return <div className="my-1.5 border-t border-dashed" />;
}

function Row({ label, v }: { label: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
