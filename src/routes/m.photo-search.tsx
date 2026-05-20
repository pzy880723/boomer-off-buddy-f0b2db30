import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { compressImage, blobToBase64 } from "@/lib/image-upload";
import { photoSearch } from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";

export const Route = createFileRoute("/m/photo-search")({
  component: PhotoSearch,
});

function PhotoSearch() {
  const fn = useServerFn(photoSearch);
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: async (file: File) => {
      const { blob, mime } = await compressImage(file, file.name);
      const b64 = await blobToBase64(blob);
      return fn({ data: { image_base64: b64, mime, limit: 5 } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const handle = async (file: File) => {
    setPreview(URL.createObjectURL(file));
    mut.mutate(file);
  };

  return (
    <MobileShell title="拍照识图" back>
      <div className="space-y-3 p-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="relative flex h-56 w-full items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed bg-muted/30 text-muted-foreground active:bg-muted"
        >
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <Camera className="h-7 w-7" />
              <span className="text-xs">拍照或选取商品图</span>
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
              if (f) handle(f);
              e.currentTarget.value = "";
            }}
          />
        </button>

        {mut.isPending ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在比对最近 200 件商品…
          </div>
        ) : null}

        {mut.data?.matches?.length ? (
          <ul className="space-y-2">
            {mut.data.matches.map((m) => (
              <li key={m.id} className="rounded-2xl border bg-card">
                <Link
                  to="/m/receive/$id"
                  params={{ id: m.parcel_id }}
                  className="flex items-center gap-3 p-2.5 active:bg-muted"
                >
                  {m.item_image_url ? (
                    <img
                      src={toThumbUrl(m.item_image_url, 128) ?? m.item_image_url}
                      alt=""
                      className="h-14 w-14 flex-none rounded border object-cover"
                      loading="lazy"
                      width={56}
                      height={56}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">
                      {m.item_title_cn || m.item_title}
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      均价 ¥{m.item_total_cny != null ? Number(m.item_total_cny).toFixed(2) : "—"}
                      {m.quantity ? ` · ×${m.quantity}` : ""}
                    </div>
                    {m.reason ? (
                      <div className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">{m.reason}</div>
                    ) : null}
                  </div>
                  <span className="rounded bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-600">
                    {Math.round((m.score ?? 0) * 100)}%
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}

        {mut.isSuccess && mut.data?.matches?.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">没有匹配的商品</div>
        ) : null}
      </div>
    </MobileShell>
  );
}
