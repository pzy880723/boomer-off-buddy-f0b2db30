import { useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Upload,
  Loader2,
  Sparkles,
  Trash2,
  CheckCircle2,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
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

export const Route = createFileRoute("/purchase/domestic/import")({
  head: () => ({ meta: [{ title: "国内小包 · 截图导入" }] }),
  component: ImportPage,
});

type ImgItem = {
  id: string;
  dataUrl: string;
  mime: string;
  file: File;
};

type DraftOrder = {
  platform: DomesticPlatform;
  source_order_no: string | null;
  seller_name: string | null;
  seller_handle: string | null;
  item_title: string | null;
  qty: number | null;
  price_cny: number | null;
  shipping_cny: number | null;
  total_cny: number | null;
  purchased_at: string | null;
  tracking_no: string | null;
  carrier: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  receiver_address: string | null;
  status: DomesticStatus;
  chat_summary: string | null;
};

function ImportPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const recognizeFn = useServerFn(recognizeDomesticScreenshots);
  const insertFn = useServerFn(bulkInsertDomesticOrders);

  const [images, setImages] = useState<ImgItem[]>([]);
  const [hintPlatform, setHintPlatform] = useState<DomesticPlatform | "auto">("auto");
  const [drafts, setDrafts] = useState<DraftOrder[]>([]);
  const [recognizing, setRecognizing] = useState(false);
  const [uploadingScreenshots, setUploadingScreenshots] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const items: ImgItem[] = await Promise.all(
      arr.map(
        (f) =>
          new Promise<ImgItem>((resolve) => {
            const r = new FileReader();
            r.onload = () =>
              resolve({
                id: crypto.randomUUID(),
                dataUrl: String(r.result),
                mime: f.type || "image/png",
                file: f,
              });
            r.readAsDataURL(f);
          }),
      ),
    );
    setImages((prev) => [...prev, ...items]);
  };

  const runRecognize = async () => {
    if (images.length === 0) return;
    setRecognizing(true);
    setDrafts([]);
    try {
      const r = await recognizeFn({
        data: {
          images: images.map((i) => ({ image_base64: i.dataUrl, mime_type: i.mime })),
          hint_platform: hintPlatform === "auto" ? undefined : hintPlatform,
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
          seller_handle: o.seller_handle ?? null,
          item_title: o.item_title ?? null,
          qty: o.qty ?? 1,
          price_cny: o.price_cny ?? null,
          shipping_cny: o.shipping_cny ?? null,
          total_cny: o.total_cny ?? null,
          purchased_at: o.purchased_at ?? null,
          tracking_no: o.tracking_no ?? null,
          carrier: o.carrier ?? null,
          receiver_name: o.receiver_name ?? null,
          receiver_phone: o.receiver_phone ?? null,
          receiver_address: o.receiver_address ?? null,
          status: (o.status as DomesticStatus) ?? "paid",
          chat_summary: o.chat_summary ?? null,
        })),
      );
      toast.success(`识别出 ${r.orders.length} 条订单`);
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
      const ext = (img.mime.split("/")[1] || "png").toLowerCase();
      const path = `${ym}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from("domestic-order-screenshots")
        .upload(path, img.file, { contentType: img.mime, upsert: false });
      if (error) throw new Error(error.message);
      const { data } = supabase.storage.from("domestic-order-screenshots").getPublicUrl(path);
      urls.push(data.publicUrl);
    }
    return urls;
  };

  const importMut = useMutation({
    mutationFn: async () => {
      setUploadingScreenshots(true);
      let urls: string[] = [];
      try {
        urls = await uploadScreenshots();
      } finally {
        setUploadingScreenshots(false);
      }
      return insertFn({
        data: {
          orders: drafts.map((d) => ({ ...d, screenshot_urls: urls })),
        },
      });
    },
    onSuccess: (r) => {
      toast.success(`已导入 ${r.inserted} 条${r.skipped ? `（跳过 ${r.skipped} 条重复）` : ""}`);
      qc.invalidateQueries({ queryKey: ["domestic-orders"] });
      qc.invalidateQueries({ queryKey: ["domestic-orders-count"] });
      nav({ to: "/purchase/domestic" });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const setDraft = (i: number, patch: Partial<DraftOrder>) =>
    setDrafts((prev) => prev.map((d, k) => (k === i ? { ...d, ...patch } : d)));

  return (
    <div className="space-y-4">
      <PageHeader
        title="国内订单截图导入"
        description="拖入多张截图，AI 自动识别成订单数组，可在下方核对修改后批量入库"
        actions={
          <Button variant="outline" size="sm" onClick={() => nav({ to: "/purchase/domestic" })}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> 返回
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-xs">平台提示</Label>
            <Select value={hintPlatform} onValueChange={(v) => setHintPlatform(v as DomesticPlatform | "auto")}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动识别</SelectItem>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">
              如果一次只导入一个平台的截图，建议手动选择以提高识别准确率
            </span>
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
            <p className="text-sm font-medium">拖入或点击选择截图（最多 15 张）</p>
            <p className="text-xs text-muted-foreground">支持闲鱼/抖音/小红书/微信聊天/拼多多 订单页 + 物流页 + 聊天记录</p>
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setImages((prev) => prev.filter((x) => x.id !== it.id));
                      }}
                      className="absolute right-1 top-1 z-10 rounded bg-background/80 p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setImages([])} disabled={recognizing}>
                  清空
                </Button>
                <Button
                  size="sm"
                  className="bg-gradient-brand hover:opacity-90"
                  disabled={recognizing || images.length === 0}
                  onClick={runRecognize}
                >
                  {recognizing ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {drafts.length > 0 ? "重新识别" : "开始 AI 识别"}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                识别结果（{drafts.length} 条，可编辑后入库）
              </h3>
              <Button
                size="sm"
                className="bg-gradient-brand hover:opacity-90"
                disabled={importMut.isPending || uploadingScreenshots}
                onClick={() => importMut.mutate()}
              >
                {importMut.isPending || uploadingScreenshots ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                {uploadingScreenshots ? "上传截图…" : `批量入库（${drafts.length}）`}
              </Button>
            </div>

            <div className="space-y-3">
              {drafts.map((d, i) => (
                <div key={i} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono">#{i + 1}</span>
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
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
                    <Field label="商品标题" value={d.item_title} onChange={(v) => setDraft(i, { item_title: v })} colSpan={2} />
                    <Field label="卖家" value={d.seller_name} onChange={(v) => setDraft(i, { seller_name: v })} />
                    <Field label="订单号" value={d.source_order_no} onChange={(v) => setDraft(i, { source_order_no: v })} />
                    <NumField label="单价 ¥" value={d.price_cny} onChange={(v) => setDraft(i, { price_cny: v })} />
                    <NumField label="运费 ¥" value={d.shipping_cny} onChange={(v) => setDraft(i, { shipping_cny: v })} />
                    <NumField label="实付 ¥" value={d.total_cny} onChange={(v) => setDraft(i, { total_cny: v })} />
                    <NumField label="数量" value={d.qty} onChange={(v) => setDraft(i, { qty: v })} />
                    <Field label="下单时间" value={d.purchased_at} onChange={(v) => setDraft(i, { purchased_at: v })} />
                    <Field label="物流单号" value={d.tracking_no} onChange={(v) => setDraft(i, { tracking_no: v })} />
                    <Field label="快递" value={d.carrier} onChange={(v) => setDraft(i, { carrier: v })} />
                    <Field label="收件人" value={d.receiver_name} onChange={(v) => setDraft(i, { receiver_name: v })} />
                    <Field label="收件电话" value={d.receiver_phone} onChange={(v) => setDraft(i, { receiver_phone: v })} />
                    <Field label="收件地址" value={d.receiver_address} onChange={(v) => setDraft(i, { receiver_address: v })} colSpan={2} />
                    {d.platform === "wechat" && (
                      <Field label="聊天摘要" value={d.chat_summary} onChange={(v) => setDraft(i, { chat_summary: v })} colSpan={4} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  colSpan,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  colSpan?: number;
}) {
  return (
    <div className={colSpan ? `md:col-span-${colSpan === 2 ? 2 : 2} lg:col-span-${colSpan}` : ""}>
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-7 text-xs"
      />
    </div>
  );
}

function NumField({
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
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="h-7 text-xs tabular-nums"
      />
    </div>
  );
}
