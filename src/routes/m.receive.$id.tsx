import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import { Camera, Check, AlertTriangle, Loader2, ArrowRight } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { getJapanParcel } from "@/lib/japan-parcel.functions";
import { markParcelDelivered, markParcelProblem } from "@/lib/mobile.functions";
import { uploadParcelImage } from "@/lib/image-upload";
import { toThumbUrl } from "@/lib/image";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/m/receive/$id")({
  component: ReceivePage,
});

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

  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState("");
  const [showProblem, setShowProblem] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const url = await uploadParcelImage(file, "receive", id);
      setPhotoUrl(url);
      toast.success("照片已上传");
    } catch (e) {
      toast.error("上传失败：" + (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  const deliverMut = useMutation({
    mutationFn: () => doDelivered({ data: { id, photo_url: photoUrl } }),
    onSuccess: () => {
      toast.success("已签收，可去分拣台");
      qc.invalidateQueries({ queryKey: ["mobile-counts"] });
      qc.invalidateQueries({ queryKey: ["mobile-parcel", id] });
      router.navigate({ to: "/m/sort/$id", params: { id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const problemMut = useMutation({
    mutationFn: () =>
      doProblem({ data: { id, note: note.trim(), photo_url: photoUrl } }),
    onSuccess: () => {
      toast.success("已标记异常");
      qc.invalidateQueries({ queryKey: ["mobile-parcel", id] });
      setShowProblem(false);
      setNote("");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const parcel = data?.row;
  const items = data?.items ?? [];
  const canDeliver = !!photoUrl && !deliverMut.isPending;

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
                  {parcel.item_title_cn || parcel.item_title || "(未填商品名)"}
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
                    <li key={it.id} className="flex items-center gap-3 px-3 py-2">
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
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="px-1 text-xs font-medium text-muted-foreground">外包装照片（必填）</h3>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="relative flex h-44 w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-muted-foreground/30 bg-muted/30 text-muted-foreground active:bg-muted"
              disabled={uploading}
            >
              {photoUrl ? (
                <img src={photoUrl} alt="外包装" className="h-full w-full object-cover" />
              ) : uploading ? (
                <Loader2 className="h-6 w-6 animate-spin" />
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  <Camera className="h-7 w-7" />
                  <span className="text-xs">拍照 / 选取照片</span>
                </div>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.currentTarget.value = "";
                }}
              />
            </button>
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
    </MobileShell>
  );
}
