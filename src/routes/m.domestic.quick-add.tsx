import { useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Camera, ImagePlus, Loader2, Sparkles, Trash2, Save, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { supabase } from "@/integrations/supabase/client";
import { recognizeDomesticScreenshots } from "@/lib/domestic-recognize.functions";
import {
  bulkInsertDomesticOrders,
  PLATFORMS,
  PLATFORM_LABEL,
  STATUSES,
  STATUS_LABEL,
  type DomesticPlatform,
  type DomesticStatus,
} from "@/lib/domestic-orders.functions";

export const Route = createFileRoute("/m/domestic/quick-add")({
  head: () => ({ meta: [{ title: "快速录入小包" }] }),
  component: QuickAddPage,
});

type ImgItem = { id: string; dataUrl: string; mime: string; file: File };
type DraftOrder = {
  platform: DomesticPlatform;
  source_order_no: string | null;
  seller_name: string | null;
  item_title: string | null;
  qty: number | null;
  price_cny: number | null;
  shipping_cny: number | null;
  total_cny: number | null;
  purchased_at: string | null;
  tracking_no: string | null;
  carrier: string | null;
  status: DomesticStatus;
  chat_summary: string | null;
};

// 压到长边 1600，JPEG 0.8
async function compressImage(file: File): Promise<{ dataUrl: string; mime: string; blob: Blob }> {
  if (!file.type.startsWith("image/")) {
    const dataUrl = await new Promise<string>((r) => {
      const fr = new FileReader();
      fr.onload = () => r(String(fr.result));
      fr.readAsDataURL(file);
    });
    return { dataUrl, mime: file.type || "image/png", blob: file };
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    const dataUrl = await new Promise<string>((r) => {
      const fr = new FileReader();
      fr.onload = () => r(String(fr.result));
      fr.readAsDataURL(file);
    });
    return { dataUrl, mime: file.type, blob: file };
  }
  const MAX = 1600;
  let { width, height } = bitmap;
  if (Math.max(width, height) > MAX) {
    const scale = MAX / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob: Blob = await new Promise((r) =>
    canvas.toBlob((b) => r(b!), "image/jpeg", 0.8),
  );
  const dataUrl: string = await new Promise((r) => {
    const fr = new FileReader();
    fr.onload = () => r(String(fr.result));
    fr.readAsDataURL(blob);
  });
  return { dataUrl, mime: "image/jpeg", blob };
}

function QuickAddPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const recognizeFn = useServerFn(recognizeDomesticScreenshots);
  const insertFn = useServerFn(bulkInsertDomesticOrders);

  const [images, setImages] = useState<ImgItem[]>([]);
  const [hint, setHint] = useState<DomesticPlatform | "auto">("auto");
  const [drafts, setDrafts] = useState<DraftOrder[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;
    const room = Math.max(0, 15 - images.length);
    const slice = arr.slice(0, room);
    if (arr.length > slice.length) toast.warning(`最多 15 张，已截断`);
    const items = await Promise.all(
      slice.map(async (f) => {
        const c = await compressImage(f);
        return {
          id: crypto.randomUUID(),
          dataUrl: c.dataUrl,
          mime: c.mime,
          file: new File([c.blob], f.name.replace(/\.\w+$/, ".jpg"), { type: c.mime }),
        };
      }),
    );
    setImages((prev) => [...prev, ...items]);
  };

  const runRecognize = async () => {
    if (images.length === 0) {
      toast.warning("请先添加截图");
      return;
    }
    setRecognizing(true);
    setDrafts([]);
    try {
      const r = await recognizeFn({
        data: {
          images: images.map((i) => ({ image_base64: i.dataUrl, mime_type: i.mime })),
          hint_platform: hint === "auto" ? undefined : hint,
        },
      });
      if (!r.ok) {
        toast.error(`识别失败：${r.reason}`);
        return;
      }
      if (r.orders.length === 0) {
        toast.warning("未识别到任何订单");
        return;
      }
      setDrafts(
        r.orders.map((o) => ({
          platform: o.platform as DomesticPlatform,
          source_order_no: o.source_order_no ?? null,
          seller_name: o.seller_name ?? null,
          item_title: o.item_title ?? null,
          qty: o.qty ?? 1,
          price_cny: o.price_cny ?? null,
          shipping_cny: o.shipping_cny ?? null,
          total_cny: o.total_cny ?? null,
          purchased_at: o.purchased_at ?? null,
          tracking_no: o.tracking_no ?? null,
          carrier: o.carrier ?? null,
          status: (o.status as DomesticStatus) ?? "paid",
          chat_summary: o.chat_summary ?? null,
        })),
      );
      toast.success(`识别出 ${r.orders.length} 条`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRecognizing(false);
    }
  };

  const uploadScreenshots = async (): Promise<string[]> => {
    const ym = new Date().toISOString().slice(0, 7);
    const urls: string[] = [];
    for (const img of images) {
      const path = `${ym}/${crypto.randomUUID()}.jpg`;
      const { error } = await supabase.storage
        .from("domestic-order-screenshots")
        .upload(path, img.file, { contentType: img.mime, upsert: false });
      if (error) throw new Error(error.message);
      const { data } = supabase.storage.from("domestic-order-screenshots").getPublicUrl(path);
      urls.push(data.publicUrl);
    }
    return urls;
  };

  const submitMut = useMutation({
    mutationFn: async () => {
      setSubmitting(true);
      try {
        const urls = images.length ? await uploadScreenshots() : [];
        return await insertFn({
          data: { orders: drafts.map((d) => ({ ...d, screenshot_urls: urls })) },
        });
      } finally {
        setSubmitting(false);
      }
    },
    onSuccess: (r) => {
      toast.success(`已入库 ${r.inserted} 条${r.skipped ? `（跳过 ${r.skipped} 条重复）` : ""}`);
      qc.invalidateQueries({ queryKey: ["domestic-orders"] });
      qc.invalidateQueries({ queryKey: ["domestic-orders-count"] });
      nav({ to: "/m" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const setDraft = (i: number, patch: Partial<DraftOrder>) =>
    setDrafts((prev) => prev.map((d, k) => (k === i ? { ...d, ...patch } : d)));

  return (
    <MobileShell title="快速录入小包" back="/m">
      <div className="space-y-4 p-3">
        {/* 平台 */}
        <div className="flex flex-wrap gap-1.5">
          {(["auto", ...PLATFORMS] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setHint(p)}
              className={`rounded-full px-3 py-1 text-xs ${
                hint === p
                  ? "bg-primary text-primary-foreground"
                  : "border bg-card text-muted-foreground"
              }`}
            >
              {p === "auto" ? "自动识别" : PLATFORM_LABEL[p]}
            </button>
          ))}
        </div>

        {/* 拍照 / 相册 */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="default"
            className="h-14 gap-2 bg-gradient-brand hover:opacity-90"
            onClick={() => cameraRef.current?.click()}
          >
            <Camera className="h-5 w-5" />
            拍照
          </Button>
          <Button variant="outline" className="h-14 gap-2" onClick={() => galleryRef.current?.click()}>
            <ImagePlus className="h-5 w-5" />
            从相册选
          </Button>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={galleryRef}
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

        {/* 缩略图 */}
        {images.length > 0 && (
          <div className="grid grid-cols-4 gap-2">
            {images.map((it, i) => (
              <div key={it.id} className="relative aspect-square overflow-hidden rounded-md border">
                <span className="absolute left-1 top-1 z-10 rounded bg-black/60 px-1 text-[10px] text-white">
                  #{i + 1}
                </span>
                <img src={it.dataUrl} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((x) => x.id !== it.id))}
                  className="absolute right-1 top-1 z-10 rounded-full bg-black/60 p-0.5 text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 识别按钮 */}
        <Button
          className="w-full bg-gradient-brand hover:opacity-90"
          disabled={recognizing || images.length === 0}
          onClick={runRecognize}
        >
          {recognizing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-2 h-4 w-4" />
          )}
          {drafts.length > 0 ? "重新识别" : `AI 识别 ${images.length ? `(${images.length})` : ""}`}
        </Button>

        {/* 结果卡片 */}
        {drafts.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">识别结果（{drafts.length} 条）</h3>
            </div>

            {drafts.map((d, i) => (
              <div key={i} className="space-y-2 rounded-lg border bg-card p-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      #{i + 1}
                    </span>
                    <Select
                      value={d.platform}
                      onValueChange={(v) => setDraft(i, { platform: v as DomesticPlatform })}
                    >
                      <SelectTrigger className="h-7 w-24 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLATFORMS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {PLATFORM_LABEL[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={d.status}
                      onValueChange={(v) => setDraft(i, { status: v as DomesticStatus })}
                    >
                      <SelectTrigger className="h-7 w-24 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-destructive"
                    onClick={() => setDrafts((prev) => prev.filter((_, k) => k !== i))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <MField label="商品" value={d.item_title} onChange={(v) => setDraft(i, { item_title: v })} />
                <div className="grid grid-cols-2 gap-2">
                  <MField label="卖家" value={d.seller_name} onChange={(v) => setDraft(i, { seller_name: v })} />
                  <MField
                    label="订单号"
                    value={d.source_order_no}
                    onChange={(v) => setDraft(i, { source_order_no: v })}
                  />
                  <MNum label="实付 ¥" value={d.total_cny} onChange={(v) => setDraft(i, { total_cny: v })} />
                  <MNum label="运费 ¥" value={d.shipping_cny} onChange={(v) => setDraft(i, { shipping_cny: v })} />
                  <MField
                    label="下单时间"
                    value={d.purchased_at}
                    onChange={(v) => setDraft(i, { purchased_at: v })}
                  />
                  <MField
                    label="物流单号"
                    value={d.tracking_no}
                    onChange={(v) => setDraft(i, { tracking_no: v })}
                  />
                </div>
                {d.platform === "wechat" && (
                  <MField
                    label="聊天摘要"
                    value={d.chat_summary}
                    onChange={(v) => setDraft(i, { chat_summary: v })}
                  />
                )}
              </div>
            ))}

            <Button
              className="w-full bg-gradient-brand hover:opacity-90"
              disabled={submitMut.isPending || submitting}
              onClick={() => submitMut.mutate()}
            >
              {submitMut.isPending || submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {submitting ? "上传截图…" : `全部入库（${drafts.length}）`}
            </Button>
          </div>
        )}
      </div>
    </MobileShell>
  );
}

function MField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div>
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 text-xs"
      />
    </div>
  );
}

function MNum({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step="0.01"
        inputMode="decimal"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="h-8 text-xs tabular-nums"
      />
    </div>
  );
}
