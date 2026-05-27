import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles, ImageIcon, Loader2, FileText, Hand } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  estimatePiecesFromTitle,
  estimatePiecesFromImage,
} from "@/lib/pack-pieces.functions";
import { updateParcelItem } from "@/lib/japan-parcel.functions";
import { computePiecePrice } from "@/lib/japan-parcel.helpers";
import { ClickableThumb } from "@/components/japan-parcel/image-lightbox";
import { toThumbUrl } from "@/lib/image";

export interface PackCalcItem {
  id: string;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
  item_total_jpy: number | null;
  pack_pieces?: number | null;
  pack_pieces_source?: string | null;
  pack_unit_note?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item: PackCalcItem;
  landedCny: number | null;
  onSaved?: (v: {
    pack_pieces: number | null;
    pack_pieces_source: string | null;
    pack_unit_note: string | null;
  }) => void;
}

type StepState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; pieces: number | null; confidence: string; reasoning: string; unit?: string | null }
  | { status: "error"; reason: string }
  | { status: "skipped"; reason: string };

export function PackPriceCalculatorDialog({ open, onOpenChange, item, landedCny, onSaved }: Props) {
  const qc = useQueryClient();
  const fnTitle = useServerFn(estimatePiecesFromTitle);
  const fnImage = useServerFn(estimatePiecesFromImage);
  const fnUpdate = useServerFn(updateParcelItem);

  const [pieces, setPieces] = useState<string>("");
  const [unit, setUnit] = useState<string>("");
  const [source, setSource] = useState<string>("manual");
  const [titleStep, setTitleStep] = useState<StepState>({ status: "idle" });
  const [imageStep, setImageStep] = useState<StepState>({ status: "idle" });
  const [saving, setSaving] = useState(false);

  // 初始化 + 自动跑标题分析
  useEffect(() => {
    if (!open) return;
    setPieces(item.pack_pieces != null ? String(item.pack_pieces) : "");
    setUnit(item.pack_unit_note ?? "");
    setSource(item.pack_pieces_source ?? "manual");
    setTitleStep({ status: "idle" });
    setImageStep({ status: "idle" });

    // 自动跑标题分析
    void runTitle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const runTitle = async () => {
    setTitleStep({ status: "running" });
    const r = await fnTitle({
      data: { title: item.item_title, title_cn: item.item_title_cn },
    });
    if (!r.ok) {
      setTitleStep({ status: "error", reason: r.reason });
      if (item.item_image_url) void runImage();
      return;
    }
    setTitleStep({
      status: "done",
      pieces: r.pieces,
      confidence: r.confidence,
      reasoning: r.reasoning,
      unit: r.unit,
    });
    if (r.pieces != null) {
      // 标题识别成功，回填
      if (!pieces || source !== "manual") {
        setPieces(String(r.pieces));
        setSource("title");
        if (r.unit && !unit) setUnit(r.unit);
      }
      // 不再触发图片步
      setImageStep({ status: "skipped", reason: "标题已识别，跳过" });
    } else if (item.item_image_url) {
      // 标题给不出，自动跑图片
      void runImage();
    } else {
      setImageStep({ status: "skipped", reason: "无图片" });
    }
  };

  const runImage = async () => {
    if (!item.item_image_url) {
      setImageStep({ status: "skipped", reason: "无图片" });
      return;
    }
    setImageStep({ status: "running" });
    const r = await fnImage({
      data: {
        // 走 Supabase 缩略图（webp, ≤1024px），AI 识别效果已饱和，传原图只会拖慢服务端 fetch
        image_url: toThumbUrl(item.item_image_url, 1024) ?? item.item_image_url,
        title: item.item_title,
        title_cn: item.item_title_cn,
      },
    });
    if (!r.ok) {
      setImageStep({ status: "error", reason: r.reason });
      return;
    }
    setImageStep({
      status: "done",
      pieces: r.pieces,
      confidence: r.confidence,
      reasoning: r.reasoning,
      unit: r.unit,
    });
    if (r.pieces != null && (!pieces || source !== "manual")) {
      setPieces(String(r.pieces));
      setSource("image");
      if (r.unit && !unit) setUnit(r.unit);
    }
  };

  const piecesNum = Number(pieces) || 0;
  const { pieceCny } = computePiecePrice(
    item.item_total_jpy,
    landedCny,
    piecesNum > 0 ? piecesNum : null,
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await fnUpdate({
        data: {
          id: item.id,
          pack_pieces: piecesNum > 0 ? piecesNum : null,
          pack_pieces_source: piecesNum > 0 ? source : null,
          pack_unit_note: unit.trim() || (piecesNum > 0 ? "个" : null),
        },
      });
      toast.success("已保存");
      await qc.invalidateQueries({ queryKey: ["jp-parcels"] });
      await qc.invalidateQueries({ queryKey: ["jp-parcels-counts"] });
      await qc.invalidateQueries({ queryKey: ["jp-parcel"] });
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" /> 拆包单价计算
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* 商品概览 */}
          <div className="flex gap-3 rounded-md border p-3">
            {item.item_image_url ? (
              <ClickableThumb
                src={item.item_image_url}
                thumbWidth={200}
                alt={item.item_title ?? ""}
                className="h-16 w-16 flex-shrink-0 rounded object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                无图
              </div>
            )}
            <div className="min-w-0 flex-1 text-xs">
              <div className="line-clamp-2 text-sm font-medium">
                {item.item_title_cn || item.item_title || "(未命名)"}
              </div>
              {item.item_title_cn && item.item_title && (
                <div className="line-clamp-1 text-[11px] text-muted-foreground">
                  {item.item_title}
                </div>
              )}
              <div className="mt-1 font-mono tabular-nums">
                <span>
                  到手{" "}
                  {landedCny != null
                    ? `RMB ${landedCny.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* 步骤 1：标题 */}
          <StepRow
            icon={<FileText className="h-3.5 w-3.5" />}
            label="① 标题分析"
            step={titleStep}
            onRetry={runTitle}
          />

          {/* 步骤 2：图片 */}
          <StepRow
            icon={<ImageIcon className="h-3.5 w-3.5" />}
            label="② 图片分析"
            step={imageStep}
            onRetry={item.item_image_url ? runImage : undefined}
          />

          {/* 输入框 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="flex h-5 items-center gap-1 text-xs">
                <Hand className="h-3 w-3" /> 包内件数
              </Label>
              <Input
                type="number"
                min={1}
                value={pieces}
                onChange={(e) => {
                  setPieces(e.target.value);
                  setSource("manual");
                }}
                placeholder="例如 100"
              />
            </div>
            <div className="space-y-1">
              <Label className="flex h-5 items-center gap-1 text-xs">
                <Hand className="h-3 w-3 opacity-0" aria-hidden /> 单件单位
              </Label>
              <Input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="个 / 张 / 枚"
              />
            </div>
          </div>

          {/* 结果 */}
          {piecesNum > 0 && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
              <div className="text-xs text-muted-foreground">单件到手成本</div>
              <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-lg font-semibold">
                  {pieceCny != null ? `RMB ${pieceCny.toFixed(2)}` : "—"}
                </span>
                <span className="text-xs text-muted-foreground">
                  / {unit || "个"}
                </span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepRow({
  icon,
  label,
  step,
  onRetry,
}: {
  icon: React.ReactNode;
  label: string;
  step: StepState;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded border p-2 text-xs">
      <div className="flex items-center gap-2">
        {icon}
        <span className="font-medium">{label}</span>
        {step.status === "running" && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
        <div className="ml-auto">
          {(step.status === "error" || step.status === "skipped" || step.status === "done") &&
            onRetry && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onRetry}>
                重试
              </Button>
            )}
        </div>
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        {step.status === "idle" && "等待中…"}
        {step.status === "running" && "分析中…"}
        {step.status === "done" && (
          <span>
            {step.pieces != null ? (
              <>
                识别为 <b className="text-foreground">{step.pieces}</b> 件
                <span className="ml-1">（{step.confidence}）</span>
              </>
            ) : (
              <span>未识别出明确数量</span>
            )}
            {step.reasoning && <span className="ml-1">· {step.reasoning}</span>}
          </span>
        )}
        {step.status === "error" && <span className="text-destructive">失败：{step.reason}</span>}
        {step.status === "skipped" && step.reason}
      </div>
    </div>
  );
}

export default PackPriceCalculatorDialog;
