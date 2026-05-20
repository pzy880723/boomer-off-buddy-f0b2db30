import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, Fragment } from "react";
import { Camera, Check, AlertTriangle, Loader2, ArrowRight, X, Plus, ImageIcon, ChevronRight } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { getJapanParcel } from "@/lib/japan-parcel.functions";
import { markParcelDelivered, markParcelProblem } from "@/lib/mobile.functions";
import { uploadParcelImage } from "@/lib/image-upload";
import { toThumbUrl } from "@/lib/image";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ItemDetailSheet, type ItemDetailValue } from "@/components/mobile/item-detail-sheet";

export const Route = createFileRoute("/m/receive/$id")({
  component: ReceivePage,
});

const MAX_PHOTOS = 9;

function ReceivePage() {
  const { id } = Route.useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const fetchParcel = useServerFn(getJapanParcel);
  const doDelivered = useServerFn(markParcelDelivered);
  const doProblem = useServerFn(markParcelProblem);

  const { data, isLoading } = useQuery({
    queryKey: ["mobile-parcel", id],
    queryFn: () => fetchParcel({ data: { id } }),
  });

  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [note, setNote] = useState("");
  const [showProblem, setShowProblem] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<ItemDetailValue | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const burstRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const continuousRef = useRef(false);

  async function handleFiles(files: FileList | null, opts?: { burst?: boolean }) {
    if (!files || files.length === 0) {
      if (opts?.burst) continuousRef.current = false;
      return;
    }
    setPhotoUrls((prev) => {
      const remain = MAX_PHOTOS - prev.length;
      if (remain <= 0) {
        toast.error(`最多 ${MAX_PHOTOS} 张`);
        return prev;
      }
      const list = Array.from(files).slice(0, remain);
      setUploading((n) => n + list.length);
      void (async () => {
        const results = await Promise.allSettled(
          list.map((f) => uploadParcelImage(f, "receive", id)),
        );
        const ok: string[] = [];
        let failed = 0;
        for (const r of results) {
          if (r.status === "fulfilled") ok.push(r.value);
          else failed++;
        }
        if (ok.length) setPhotoUrls((p) => [...p, ...ok].slice(0, MAX_PHOTOS));
        setUploading((n) => Math.max(0, n - list.length));
        if (failed) toast.error(`${failed} 张上传失败`);
        // 连拍：上传完成后自动再次唤起相机，直到达到上限或用户取消
        if (opts?.burst && continuousRef.current) {
          setTimeout(() => {
            setPhotoUrls((cur) => {
              if (cur.length < MAX_PHOTOS && continuousRef.current) {
                burstRef.current?.click();
              }
              return cur;
            });
          }, 150);
        }
      })();
      return prev;
    });
  }

  const deliverMut = useMutation({
    mutationFn: () => doDelivered({ data: { id, photo_urls: photoUrls } }),
    onSuccess: () => {
      toast.success("已签收，可去分拣台");
      qc.invalidateQueries({ queryKey: ["mobile-counts"] });
      qc.invalidateQueries({ queryKey: ["mobile-parcel", id] });
      qc.invalidateQueries({ queryKey: ["mobile-parcels"] });
      router.navigate({ to: "/m/sort/$id", params: { id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const problemMut = useMutation({
    mutationFn: () =>
      doProblem({ data: { id, note: note.trim(), photo_urls: photoUrls } }),
    onSuccess: () => {
      toast.success("已标记异常");
      qc.invalidateQueries({ queryKey: ["mobile-parcel", id] });
      setShowProblem(false);
      setNote("");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const parcel = data?.row;
  const items = (data?.items ?? []) as ItemDetailValue[];
  const canDeliver = photoUrls.length > 0 && !deliverMut.isPending;

  return (
    <MobileShell title="到货签收" back>
      {isLoading || !parcel ? (
        <div className="p-12 text-center text-muted-foreground">
          <Loader2 className="mx-auto h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-4 p-3">
          <section className="rounded-2xl border bg-card p-3 shadow-sm">
            <div className="flex items-start gap-3">
              {parcel.item_image_url ? (
                <img
                  src={toThumbUrl(parcel.item_image_url, 256) ?? parcel.item_image_url}
                  alt=""
                  className="h-16 w-16 flex-none rounded-lg border object-cover"
                  loading="lazy"
                  width={64}
                  height={64}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="line-clamp-2 text-sm font-semibold">
                  {(() => {
                    const first = items[0];
                    const name = first
                      ? first.item_title_cn || first.item_title || ""
                      : parcel.item_title_cn || parcel.item_title || "";
                    if (!name) return "(未填商品名)";
                    const head = name.length > 14 ? name.slice(0, 14) + "…" : name;
                    return items.length > 1 ? `${head} 等 ${items.length} 件商品` : name;
                  })()}
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">
                  {parcel.tracking_no || parcel.source_order_no || "无单号"}
                </div>
                {parcel.is_problem ? (
                  <span className="mt-1 inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                    <AlertTriangle className="h-3 w-3" /> 异常
                  </span>
                ) : null}
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 border-t pt-3 text-[11px]">
              {[
                ["状态", parcel.status],
                ["国际单号", parcel.tracking_no],
                ["来源订单号", parcel.source_order_no],
                ["卖家", parcel.seller],
                ["商品合计", parcel.total_cny != null ? `¥${Number(parcel.total_cny).toFixed(2)}` : null],
                ["国际运费", parcel.intl_total_cny != null ? `¥${Number(parcel.intl_total_cny).toFixed(2)}` : null],
                ["关税", parcel.tariff_cny != null ? `¥${Number(parcel.tariff_cny).toFixed(2)}` : null],
                ["合计", parcel.grand_total_cny != null ? `¥${Number(parcel.grand_total_cny).toFixed(2)}` : null],
                ["重量", parcel.weight_g != null ? `${parcel.weight_g} g` : (parcel.total_weight_g != null ? `${parcel.total_weight_g} g` : null)],
                ["件数", items.length || null],
                ["购买时间", parcel.purchased_at ? new Date(parcel.purchased_at).toLocaleString("zh-CN") : null],
                ["付款时间", parcel.intl_pay_at ? new Date(parcel.intl_pay_at).toLocaleString("zh-CN") : null],
                ["签收时间", parcel.received_at ? new Date(parcel.received_at).toLocaleString("zh-CN") : null],
                ["仓位", parcel.warehouse_location],
                ["备注", parcel.notes],
              ]
                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                .map(([k, v]) => (
                  <Fragment key={k as string}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 break-words text-foreground">{String(v)}</dd>
                  </Fragment>
                ))}
            </dl>
          </section>


          <section className="space-y-2">
            <h3 className="px-1 text-xs font-medium text-muted-foreground">
              子商品 {items.length}
            </h3>
            <div className="rounded-2xl border bg-card shadow-sm">
              {items.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  没有子商品
                </div>
              ) : (
                <ul className="divide-y">
                  {items.map((it) => (
                    <li key={it.id}>
                      <button
                        type="button"
                        onClick={() => setDetailItem(it)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left active:bg-muted"
                      >
                        {it.item_image_url ? (
                          <img
                            src={toThumbUrl(it.item_image_url, 128) ?? it.item_image_url}
                            alt=""
                            className="h-10 w-10 flex-none rounded border object-cover"
                            loading="lazy"
                            width={40}
                            height={40}
                          />
                        ) : (
                          <div className="h-10 w-10 flex-none rounded border bg-muted" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs">
                            {it.item_title_cn || it.item_title}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            ×{it.quantity ?? 1} · ¥
                            {it.item_total_cny != null ? Number(it.item_total_cny).toFixed(2) : "—"}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 flex-none text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="px-1 text-xs font-medium text-muted-foreground">
              到货照片（必填，最多 {MAX_PHOTOS} 张）
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {photoUrls.map((url, i) => (
                <div
                  key={url + i}
                  className="relative aspect-square overflow-hidden rounded-xl border bg-muted"
                >
                  <img src={url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotoUrls((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
                    aria-label="删除"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {photoUrls.length < MAX_PHOTOS ? (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/30 text-muted-foreground active:bg-muted"
                  disabled={uploading > 0}
                >
                  {uploading > 0 ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <>
                      <Plus className="h-5 w-5" />
                      <span className="text-[10px]">添加</span>
                    </>
                  )}
                </button>
              ) : null}
            </div>
            <input
              ref={captureRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            <input
              ref={burstRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files, { burst: true });
                e.currentTarget.value = "";
              }}
            />
            <input
              ref={galleryRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                e.currentTarget.value = "";
              }}
            />
            {continuousRef.current && uploading === 0 ? null : null}
          </section>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Button
              variant="outline"
              className="h-12 text-destructive"
              onClick={() => setShowProblem((v) => !v)}
            >
              <AlertTriangle className="mr-1 h-4 w-4" /> 异常
            </Button>
            <Button
              className="h-12"
              disabled={!canDeliver}
              onClick={() => deliverMut.mutate()}
            >
              {deliverMut.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              一键签收
            </Button>
          </div>

          {showProblem ? (
            <section className="space-y-2 rounded-2xl border border-destructive/30 bg-destructive/5 p-3">
              <h3 className="text-xs font-medium text-destructive">异常说明</h3>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如：外包装破损 / 数量不符 / 缺件 …"
                rows={3}
              />
              <Button
                variant="destructive"
                className="w-full"
                disabled={!note.trim() || problemMut.isPending}
                onClick={() => problemMut.mutate()}
              >
                {problemMut.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : null}
                提交异常
              </Button>
            </section>
          ) : null}

          {parcel.status === "delivered" || parcel.status === "completed" ? (
            <Link
              to="/m/sort/$id"
              params={{ id }}
              className="flex h-12 items-center justify-center gap-1 rounded-xl border bg-muted/40 text-sm font-medium active:bg-muted"
            >
              去分拣台 <ArrowRight className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      )}

      {/* 拍照 / 相册 picker */}
      {pickerOpen ? (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/50"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-full space-y-2 rounded-t-2xl bg-card p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border bg-background text-sm font-medium active:bg-muted"
              onClick={() => {
                setPickerOpen(false);
                captureRef.current?.click();
              }}
            >
              <Camera className="h-4 w-4" /> 拍照
            </button>
            <button
              type="button"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border bg-background text-sm font-medium active:bg-muted"
              onClick={() => {
                setPickerOpen(false);
                galleryRef.current?.click();
              }}
            >
              <ImageIcon className="h-4 w-4" /> 从相册选择
            </button>
            <button
              type="button"
              className="h-12 w-full rounded-xl text-sm text-muted-foreground"
              onClick={() => setPickerOpen(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <ItemDetailSheet
        open={!!detailItem}
        onOpenChange={(o) => !o && setDetailItem(null)}
        item={detailItem}
      />
    </MobileShell>
  );
}
