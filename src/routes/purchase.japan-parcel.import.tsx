import { useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Upload,
  Loader2,
  CheckCircle2,
  XCircle,
  Trash2,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { ClickableThumb } from "@/components/japan-parcel/image-lightbox";
import {
  parseMerukiParcelScreenshots,
  importParsedParcel,
  type ParsedParent,
  type ParsedItem,
  type ParsedTimelineEntry,
} from "@/lib/meruki-parse.functions";
import { peekOrderNo } from "@/lib/recognize.functions";
import { lookupExistingParcelByOrderNo } from "@/lib/japan-parcel.functions";

export const Route = createFileRoute("/purchase/japan-parcel/import")({
  head: () => ({ meta: [{ title: "截图批量导入 · BOOMER OFF" }] }),
  component: ImportPage,
});

type ImageItem = {
  id: string;
  dataUrl: string;
  mime: string;
  state: "pending" | "uploading" | "parsing" | "done" | "error";
  reason?: string;
};

type ParseResult = {
  parent: ParsedParent;
  items: ParsedItem[];
  status_timeline: ParsedTimelineEntry[];
  derived_status: string;
  already_exists: boolean;
};

const STEPS = [
  { key: "upload", label: "上传截图" },
  { key: "parse", label: "AI 识别" },
  { key: "review", label: "核对预览" },
  { key: "import", label: "入库" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

function StepBar({ current }: { current: StepKey }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((s, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <div key={s.key} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
                done && "bg-emerald-500 text-white",
                active && "bg-primary text-primary-foreground ring-2 ring-primary/30",
                !done && !active && "bg-muted text-muted-foreground",
              )}
            >
              {done ? "✓" : i + 1}
            </div>
            <span
              className={cn(
                "text-xs",
                active ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && <div className="mx-1 h-px w-6 bg-border" />}
          </div>
        );
      })}
    </div>
  );
}

type ExistingMatch = {
  id: string;
  source_order_no: string | null;
  created_at: string;
  status: string;
  status_text: string | null;
  item_title: string | null;
  item_title_cn: string | null;
};

function ImportPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const parseFn = useServerFn(parseMerukiParcelScreenshots);
  const importFn = useServerFn(importParsedParcel);
  const peekFn = useServerFn(peekOrderNo);
  const lookupFn = useServerFn(lookupExistingParcelByOrderNo);

  const [images, setImages] = useState<ImageItem[]>([]);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingMatch | null>(null);
  const [peeking, setPeeking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentStep: StepKey = result
    ? "review"
    : parsing
      ? "parse"
      : images.length
        ? "upload"
        : "upload";

  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const newItems: ImageItem[] = await Promise.all(
      arr.map(
        (f) =>
          new Promise<ImageItem>((resolve) => {
            const r = new FileReader();
            r.onload = () =>
              resolve({
                id: crypto.randomUUID(),
                dataUrl: String(r.result),
                mime: f.type || "image/png",
                state: "pending",
              });
            r.readAsDataURL(f);
          }),
      ),
    );
    setImages((prev) => [...prev, ...newItems]);
    setResult(null);
    setParseError(null);
  };

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((x) => x.id !== id));
  };

  const runParse = async (opts: { force?: boolean } = {}) => {
    if (images.length === 0) return;
    setParseError(null);
    setResult(null);
    setExisting(null);

    // 预扫第一张图，命中已存在则拦截
    if (!opts.force) {
      setPeeking(true);
      try {
        const peek = await peekFn({
          data: {
            image_base64: images[0].dataUrl,
            mime_type: images[0].mime,
          },
        });
        if (peek.ok && peek.order_no) {
          const lk = await lookupFn({ data: { order_nos: [peek.order_no] } });
          if (lk.matches.length > 0) {
            setExisting(lk.matches[0] as ExistingMatch);
            setPeeking(false);
            return;
          }
        }
      } catch {
        // 预扫失败不阻塞，直接走完整识别
      } finally {
        setPeeking(false);
      }
    }

    setParsing(true);
    setImages((prev) => prev.map((x) => ({ ...x, state: "uploading" })));
    await new Promise((r) => setTimeout(r, 200));
    setImages((prev) => prev.map((x) => ({ ...x, state: "parsing" })));

    try {
      const r = await parseFn({
        data: {
          images: images.map((x) => ({
            image_base64: x.dataUrl,
            mime_type: x.mime,
          })),
        },
      });
      if (!r.ok) {
        setParseError(r.reason ?? "AI 识别失败");
        setImages((prev) =>
          prev.map((x) => ({ ...x, state: "error", reason: r.reason })),
        );
        toast.error(`识别失败:${r.reason}`);
      } else {
        setResult({
          parent: r.parent,
          items: r.items,
          status_timeline: r.status_timeline,
          derived_status: r.derived_status,
          already_exists: r.already_exists,
        });
        setImages((prev) => prev.map((x) => ({ ...x, state: "done" })));
      }
    } catch (e) {
      const msg = (e as Error).message;
      setParseError(msg);
      setImages((prev) =>
        prev.map((x) => ({ ...x, state: "error", reason: msg })),
      );
      toast.error(`识别失败：${msg}`);
    } finally {
      setParsing(false);
    }
  };

  const importMut = useMutation({
    mutationFn: (overwrite: boolean) => {
      if (!result) throw new Error("无解析结果");
      return importFn({
        data: {
          parent: result.parent,
          items: result.items,
          status_timeline: result.status_timeline,
          status: result.derived_status,
          overwrite,
        },
      });
    },
    onSuccess: (r) => {
      if (!r.ok) {
        toast.warning(r.reason ?? "未导入");
        return;
      }
      toast.success(
        r.replaced
          ? `已覆盖更新（${r.items_inserted} 条子订单）`
          : `导入成功（${r.items_inserted} 条子订单）`,
      );
      qc.invalidateQueries({ queryKey: ["jp-parcels"] });
      if (r.parent_id) nav({ to: "/purchase/japan-parcel/$id", params: { id: r.parent_id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const updateParentField = (key: keyof ParsedParent, val: string | number | null) => {
    if (!result) return;
    setResult({ ...result, parent: { ...result.parent, [key]: val } });
  };

  const updateItemField = (
    idx: number,
    key: keyof ParsedItem,
    val: string | number | null,
  ) => {
    if (!result) return;
    const items = result.items.map((it, i) => (i === idx ? { ...it, [key]: val } : it));
    setResult({ ...result, items });
  };

  const removeItem = (idx: number) => {
    if (!result) return;
    setResult({ ...result, items: result.items.filter((_, i) => i !== idx) });
  };

  const progressPct = result ? 75 : parsing ? 40 : images.length ? 15 : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="截图批量导入"
        description="一次拖入同一个大包裹的多张截图（订单基础 / 状态时间线 / 国际物流费用 / 子订单），AI 自动识别成父订单 + 子订单"
        actions={
          <Button variant="outline" size="sm" onClick={() => nav({ to: "/purchase/japan-parcel" })}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> 返回
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StepBar current={currentStep} />
            <div className="text-xs text-muted-foreground">
              {images.length} 张图 · {result?.items.length ?? 0} 条子订单
            </div>
          </div>
          <Progress value={progressPct} className="h-1.5" />
        </CardContent>
      </Card>

      {/* Upload area */}
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="rounded-md border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">📌 推荐工作流</p>
            <ol className="list-decimal space-y-0.5 pl-5">
              <li>用 <b>GoFullPage</b> / <b>FireShot</b> 把 meruki 大包裹详情页整页截图</li>
              <li>或者 F12 设备模式下分块截：订单基础信息 / 订单状态 / 国际物流费用明细 / 每个子订单</li>
              <li>把这些图（属于同一个大包裹）一次性拖到下方 → 点"开始 AI 识别"</li>
            </ol>
          </div>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
            }}
            onClick={() => inputRef.current?.click()}
            className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-center hover:border-primary/50 hover:bg-muted/30"
          >
            <Upload className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">拖入或点击选择多张截图</p>
            <p className="text-xs text-muted-foreground">同一个大包裹的所有截图请一次性放进来</p>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          {images.length > 0 && (
            <>
              <div className="grid grid-cols-3 gap-2 md:grid-cols-5 lg:grid-cols-6">
                {images.map((it, i) => (
                  <div key={it.id} className="group relative rounded-md border p-1.5">
                    <div className="absolute left-1 top-1 z-10 rounded bg-background/80 px-1 text-[10px] font-medium">
                      #{i + 1}
                    </div>
                    <img src={it.dataUrl} alt="" className="h-24 w-full rounded object-cover" />
                    <div className="mt-1 flex items-center justify-between text-[11px]">
                      {it.state === "pending" && <span className="text-muted-foreground">待处理</span>}
                      {it.state === "uploading" && (
                        <span className="flex items-center gap-1 text-blue-600">
                          <Loader2 className="h-3 w-3 animate-spin" /> 上传中
                        </span>
                      )}
                      {it.state === "parsing" && (
                        <span className="flex items-center gap-1 text-amber-600">
                          <Loader2 className="h-3 w-3 animate-spin" /> 识别中
                        </span>
                      )}
                      {it.state === "done" && (
                        <span className="flex items-center gap-1 text-emerald-600">
                          <CheckCircle2 className="h-3 w-3" /> 完成
                        </span>
                      )}
                      {it.state === "error" && (
                        <span
                          className="flex items-center gap-1 text-destructive"
                          title={it.reason}
                        >
                          <XCircle className="h-3 w-3" /> 失败
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeImage(it.id);
                        }}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setImages([]);
                    setResult(null);
                    setParseError(null);
                    setExisting(null);
                  }}
                  disabled={parsing || peeking}
                >
                  清空
                </Button>
                <Button
                  size="sm"
                  className="bg-gradient-brand hover:opacity-90"
                  disabled={parsing || peeking || images.length === 0}
                  onClick={() => runParse()}
                >
                  {parsing || peeking ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {peeking ? "查重中…" : result ? "重新识别" : "开始 AI 识别"}
                </Button>
              </div>

              {existing && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs">
                  <div className="mb-2 font-medium text-amber-900">
                    ⚠️ 该订单已存在,无需再次识别
                  </div>
                  <div className="space-y-0.5 text-amber-900/80">
                    <div>订单号:<span className="font-mono">{existing.source_order_no}</span></div>
                    <div>创建时间:{new Date(existing.created_at).toLocaleString("zh-CN")}</div>
                    <div>当前状态:{existing.status_text ?? existing.status}</div>
                    {(existing.item_title_cn ?? existing.item_title) && (
                      <div className="truncate">标题:{existing.item_title_cn ?? existing.item_title}</div>
                    )}
                  </div>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => nav({ to: "/purchase/japan-parcel/$id", params: { id: existing.id } })}
                    >
                      打开包裹
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runParse({ force: true })}
                      disabled={parsing}
                    >
                      仍要重新识别
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExisting(null)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              )}

              {parseError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  <div className="font-medium">识别失败</div>
                  <div className="mt-1 break-words">{parseError}</div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Preview / edit */}
      {result && (
        <>
          <Card>
            <CardContent className="space-y-4 py-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">父订单（大包裹）</h3>
                {result.already_exists && (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                    已存在同单号
                  </span>
                )}
              </div>

              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                <Field label="父订单号" v={result.parent.source_order_no ?? ""} onChange={(v) => updateParentField("source_order_no", v)} />
                <Field label="国际物流单号" v={result.parent.tracking_no ?? ""} onChange={(v) => updateParentField("tracking_no", v)} />
                <Field label="状态原文" v={result.parent.status_text ?? ""} onChange={(v) => updateParentField("status_text", v)} />
                <Field label="总重量 (g)" type="number" v={result.parent.total_weight_g ?? ""} onChange={(v) => updateParentField("total_weight_g", v === "" ? null : Number(v))} />
                <Field label="体积 (cm³)" type="number" v={result.parent.volume_cm3 ?? ""} onChange={(v) => updateParentField("volume_cm3", v === "" ? null : Number(v))} />
                <Field label="最大边长 (cm)" type="number" v={result.parent.max_side_cm ?? ""} onChange={(v) => updateParentField("max_side_cm", v === "" ? null : Number(v))} />
                <Field label="收货人" v={result.parent.receiver_name ?? ""} onChange={(v) => updateParentField("receiver_name", v)} />
                <Field label="电话" v={result.parent.receiver_phone ?? ""} onChange={(v) => updateParentField("receiver_phone", v)} />
                <Field label="收货地址" v={result.parent.receiver_address ?? ""} onChange={(v) => updateParentField("receiver_address", v)} />
              </div>

              <div className="border-t pt-3">
                <h4 className="mb-2 text-xs font-semibold text-muted-foreground">国际物流费用明细</h4>
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  <Field label="总计 JPY" type="number" v={result.parent.intl_total_jpy ?? ""} onChange={(v) => updateParentField("intl_total_jpy", v === "" ? null : Number(v))} />
                  <Field label="总计 CNY" type="number" v={result.parent.intl_total_cny ?? ""} onChange={(v) => updateParentField("intl_total_cny", v === "" ? null : Number(v))} />
                  <Field label="国际物流费 JPY" type="number" v={result.parent.intl_freight_jpy ?? ""} onChange={(v) => updateParentField("intl_freight_jpy", v === "" ? null : Number(v))} />
                  <Field label="发送方式" v={result.parent.intl_ship_method ?? ""} onChange={(v) => updateParentField("intl_ship_method", v)} />
                  <Field label="收费方式" v={result.parent.intl_charge_method ?? ""} onChange={(v) => updateParentField("intl_charge_method", v)} />
                  <Field label="强化加固 JPY" type="number" v={result.parent.intl_reinforce_jpy ?? ""} onChange={(v) => updateParentField("intl_reinforce_jpy", v === "" ? null : Number(v))} />
                  <Field label="发送手续费 JPY" type="number" v={result.parent.intl_send_fee_jpy ?? ""} onChange={(v) => updateParentField("intl_send_fee_jpy", v === "" ? null : Number(v))} />
                  <Field label="拍照费 JPY" type="number" v={result.parent.intl_photo_fee_jpy ?? ""} onChange={(v) => updateParentField("intl_photo_fee_jpy", v === "" ? null : Number(v))} />
                  <Field label="合单手续费 JPY" type="number" v={result.parent.intl_merge_fee_jpy ?? ""} onChange={(v) => updateParentField("intl_merge_fee_jpy", v === "" ? null : Number(v))} />
                </div>
              </div>

              {result.status_timeline.length > 0 && (
                <div className="border-t pt-3">
                  <h4 className="mb-2 text-xs font-semibold text-muted-foreground">状态时间线</h4>
                  <ul className="space-y-1 text-xs">
                    {result.status_timeline.map((t, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="font-mono text-muted-foreground">{t.at ?? "—"}</span>
                        <span>{t.text ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 py-4">
              <h3 className="text-sm font-semibold">
                子订单 <span className="text-muted-foreground font-normal">({result.items.length})</span>
              </h3>
              {result.items.length === 0 && (
                <p className="text-xs text-muted-foreground">未识别到子订单</p>
              )}
              <div className="space-y-3">
                {result.items.map((it, idx) => (
                  <div key={idx} className="rounded-md border p-3">
                    <div className="mb-2 flex items-start gap-3">
                      {it.item_image_url ? (
                        <ClickableThumb src={it.item_image_url} thumbWidth={200} className="h-16 w-16 flex-shrink-0 rounded object-cover" />
                      ) : (
                        <div className="h-16 w-16 flex-shrink-0 rounded bg-muted" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            #{idx + 1} · {it.sub_order_no || "无子单号"}
                          </span>
                          <button onClick={() => removeItem(idx)} className="text-muted-foreground hover:text-destructive">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="mt-1 truncate text-sm font-medium">
                          {it.item_title || it.item_title_cn || "(未命名)"}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {it.source_platform || "—"} · {it.condition || "—"} · 入库 {it.weight_g ?? "—"}g
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-2 text-xs md:grid-cols-3 lg:grid-cols-4">
                      <Field label="单价 JPY" type="number" v={it.unit_price_jpy ?? ""} onChange={(v) => updateItemField(idx, "unit_price_jpy", v === "" ? null : Number(v))} />
                      <Field label="数量" type="number" v={it.quantity ?? ""} onChange={(v) => updateItemField(idx, "quantity", v === "" ? null : Number(v))} />
                      <Field label="商品费用 JPY" type="number" v={it.item_total_jpy ?? ""} onChange={(v) => updateItemField(idx, "item_total_jpy", v === "" ? null : Number(v))} />
                      <Field label="商品费用 CNY" type="number" v={it.item_total_cny ?? ""} onChange={(v) => updateItemField(idx, "item_total_cny", v === "" ? null : Number(v))} />
                      <Field label="商品价格 JPY" type="number" v={it.item_price_jpy ?? ""} onChange={(v) => updateItemField(idx, "item_price_jpy", v === "" ? null : Number(v))} />
                      <Field label="手续费 JPY" type="number" v={it.service_fee_jpy ?? ""} onChange={(v) => updateItemField(idx, "service_fee_jpy", v === "" ? null : Number(v))} />
                      <Field label="日本国内运费 JPY" type="number" v={it.domestic_freight_jpy ?? ""} onChange={(v) => updateItemField(idx, "domestic_freight_jpy", v === "" ? null : Number(v))} />
                      <Field label="运费补差 JPY" type="number" v={it.freight_diff_jpy ?? ""} onChange={(v) => updateItemField(idx, "freight_diff_jpy", v === "" ? null : Number(v))} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 border-t pt-3">
                <Button variant="outline" size="sm" onClick={() => runParse({ force: true })} disabled={parsing}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> 重新识别
                </Button>
                {result.already_exists && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => importMut.mutate(true)}
                    disabled={importMut.isPending}
                  >
                    覆盖更新
                  </Button>
                )}
                <Button
                  size="sm"
                  className="bg-gradient-brand hover:opacity-90"
                  onClick={() => importMut.mutate(false)}
                  disabled={importMut.isPending || !result.parent.source_order_no}
                >
                  {importMut.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  确认导入
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {images.length === 0 && !result && (
        <p className="text-center text-xs text-muted-foreground">
          也可以走{" "}
          <Link to="/purchase/japan-parcel/new" search={{ tab: "ai" as const }} className="underline">
            单条 AI 识图
          </Link>{" "}
          或{" "}
          <Link to="/purchase/japan-parcel/new" className="underline">
            手动新建
          </Link>
          。
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  v,
  onChange,
  type = "text",
}: {
  label: string;
  v: string | number;
  onChange: (v: string) => void;
  type?: "text" | "number";
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        className="h-8 text-xs"
        type={type}
        value={v as string | number}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
