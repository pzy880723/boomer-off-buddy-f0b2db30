import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClickableThumb } from "./image-lightbox";
import { Package, ExternalLink } from "lucide-react";
import {
  computeParcelItemLanded,
  computePiecePrice,
  formatCny,
  formatJpy,
} from "@/lib/japan-parcel.helpers";
import { tariffCategoryLabel } from "@/lib/tariff";

export interface ItemCardItem {
  id: string;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
  item_total_jpy: number | null;
  item_total_cny: number | null;
  quantity?: number | null;
  unit_price_jpy?: number | null;
  weight_g?: number | null;
  sub_order_no?: string | null;
  tariff_category?: string | null;
  tariff_rate?: number | null;
  pack_pieces?: number | null;
  pack_pieces_source?: string | null;
  pack_unit_note?: string | null;
}

export interface ItemCardParcel {
  id: string;
  source_order_no: string | null;
  tracking_no: string | null;
  intl_total_jpy?: number | null;
  intl_exchange_rate?: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item: ItemCardItem | null;
  parcel: ItemCardParcel | null;
  /** 所属包裹的全部商品（用于按重量分摊运费） */
  siblings: ItemCardItem[];
  onOpenParcel?: () => void;
}

export function ItemCardDialog({
  open,
  onOpenChange,
  item,
  parcel,
  siblings,
  onOpenParcel,
}: Props) {
  if (!item || !parcel) return null;

  const landedMap = computeParcelItemLanded(
    {
      intl_total_jpy: parcel.intl_total_jpy ?? null,
      intl_exchange_rate: parcel.intl_exchange_rate ?? null,
    },
    siblings,
  );
  const landed = landedMap.get(item.id) ?? null;

  const piecesNum = item.pack_pieces ?? null;
  const { pieceCny, pieceJpy } = computePiecePrice(
    item.item_total_jpy,
    landed?.landedCny ?? null,
    piecesNum,
  );
  const unitLabel = item.pack_unit_note || "个";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Package className="h-4 w-4 text-primary" /> 商品卡片
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* 商品主体 */}
          <div className="flex gap-3 rounded-md border p-3">
            {item.item_image_url ? (
              <ClickableThumb
                src={item.item_image_url}
                thumbWidth={240}
                alt={item.item_title ?? ""}
                className="h-24 w-24 flex-shrink-0 rounded object-cover"
              />
            ) : (
              <div className="flex h-24 w-24 flex-shrink-0 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                无图
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium leading-snug">
                {item.item_title_cn || item.item_title || "(未命名)"}
              </div>
              {item.item_title_cn && item.item_title && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                  {item.item_title}
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                {item.sub_order_no && (
                  <Badge variant="secondary" className="font-mono">
                    {item.sub_order_no}
                  </Badge>
                )}
                {item.tariff_category && (
                  <Badge variant="outline">
                    {tariffCategoryLabel(item.tariff_category)}
                    {item.tariff_rate
                      ? ` · ${(Number(item.tariff_rate) * 100).toFixed(0)}%`
                      : ""}
                  </Badge>
                )}
                {item.quantity != null && (
                  <Badge variant="outline">数量 ×{item.quantity}</Badge>
                )}
                {item.weight_g != null && (
                  <Badge variant="outline">{item.weight_g}g</Badge>
                )}
              </div>
            </div>
          </div>

          {/* 金额 / 到手价拆解 */}
          <div className="rounded-md border p-3 text-xs font-mono tabular-nums">
            <Row label="商品金额" value={formatJpy(item.item_total_jpy)} />
            {item.unit_price_jpy != null && (
              <Row label="单价" value={formatJpy(item.unit_price_jpy)} />
            )}
            {landed && (
              <>
                <Row
                  label="商品金额 (RMB)"
                  value={landed.itemCny != null ? formatCny(landed.itemCny) : "—"}
                />
                <Row
                  label="均摊运费（按重量）"
                  value={
                    landed.freightShareCny != null
                      ? formatCny(landed.freightShareCny)
                      : "—"
                  }
                />
                <Row
                  label={
                    item.tariff_rate
                      ? `关税 (${(Number(item.tariff_rate) * 100).toFixed(0)}%)`
                      : "关税"
                  }
                  value={
                    item.tariff_rate && landed.tariffCny != null
                      ? formatCny(landed.tariffCny)
                      : "—"
                  }
                />
                <div className="mt-2 flex items-baseline justify-between border-t pt-2 font-semibold">
                  <span className="font-sans">到手价</span>
                  <span>
                    {landed.landedCny != null ? formatCny(landed.landedCny) : "—"}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* 拆包单价 */}
          {piecesNum != null && piecesNum > 0 && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
              <div className="flex items-baseline justify-between">
                <span className="text-muted-foreground">
                  拆 {piecesNum}
                  {unitLabel}
                  {item.pack_pieces_source === "title"
                    ? " 📝"
                    : item.pack_pieces_source === "image"
                      ? " 🖼️"
                      : ""}
                </span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  {pieceCny != null
                    ? `RMB ${pieceCny.toFixed(2)}`
                    : pieceJpy != null
                      ? `JPY ${pieceJpy.toFixed(0)}`
                      : "—"}
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                    / {unitLabel}
                  </span>
                </span>
              </div>
            </div>
          )}

          {/* 所属包裹 */}
          <div className="rounded-md border p-3 text-xs">
            <div className="text-muted-foreground">所属包裹</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="min-w-0 font-mono text-sm">
                {parcel.tracking_no || parcel.source_order_no || parcel.id.slice(0, 8)}
              </div>
              {onOpenParcel && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={onOpenParcel}
                >
                  <ExternalLink className="mr-1 h-3 w-3" />
                  打开包裹
                </Button>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="font-sans text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default ItemCardDialog;
