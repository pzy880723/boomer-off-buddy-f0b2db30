import { useRef, useState } from "react";
import { Camera, ImageIcon, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { uploadParcelImage } from "@/lib/image-upload";

type Folder = "items" | "receive" | "sort" | "search";

export function PhotoUploaderGrid({
  value,
  onChange,
  max = 9,
  folder = "receive",
  parcelId,
  cols = 3,
}: {
  value: string[];
  onChange: (urls: string[]) => void;
  max?: number;
  folder?: Folder;
  parcelId?: string;
  cols?: 3 | 4;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const captureRef = useRef<HTMLInputElement>(null);
  const burstRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const continuousRef = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  async function handleFiles(files: FileList | null, opts?: { burst?: boolean }) {
    if (!files || files.length === 0) {
      if (opts?.burst) continuousRef.current = false;
      return;
    }
    const cur = valueRef.current;
    const remain = max - cur.length;
    if (remain <= 0) {
      toast.error(`最多 ${max} 张`);
      return;
    }
    const list = Array.from(files).slice(0, remain);
    setUploading((n) => n + list.length);
    const results = await Promise.allSettled(
      list.map((f) => uploadParcelImage(f, folder, parcelId)),
    );
    const ok: string[] = [];
    let failed = 0;
    for (const r of results) {
      if (r.status === "fulfilled") ok.push(r.value);
      else failed++;
    }
    setUploading((n) => Math.max(0, n - list.length));
    if (ok.length) {
      const next = [...valueRef.current, ...ok].slice(0, max);
      valueRef.current = next;
      onChange(next);
    }
    if (failed) toast.error(`${failed} 张上传失败`);
    if (opts?.burst && continuousRef.current) {
      setTimeout(() => {
        if (valueRef.current.length < max && continuousRef.current) {
          burstRef.current?.click();
        }
      }, 150);
    }
  }

  const remove = (i: number) => {
    const next = value.filter((_, idx) => idx !== i);
    valueRef.current = next;
    onChange(next);
  };

  const gridCols = cols === 4 ? "grid-cols-4" : "grid-cols-3";

  return (
    <>
      <div className={`grid ${gridCols} gap-2`}>
        {value.map((url, i) => (
          <div
            key={url + i}
            className="relative aspect-square overflow-hidden rounded-xl border bg-muted"
          >
            <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
            <button
              type="button"
              onClick={() => remove(i)}
              className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
              aria-label="删除"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {value.length < max ? (
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

      {pickerOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/50"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="w-full space-y-2 rounded-t-2xl bg-card p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border bg-primary text-sm font-medium text-primary-foreground active:opacity-80"
              onClick={() => {
                setPickerOpen(false);
                continuousRef.current = true;
                burstRef.current?.click();
              }}
            >
              <Camera className="h-4 w-4" /> 连拍（自动续拍直到完成）
            </button>
            <button
              type="button"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border bg-background text-sm font-medium active:bg-muted"
              onClick={() => {
                setPickerOpen(false);
                continuousRef.current = false;
                captureRef.current?.click();
              }}
            >
              <Camera className="h-4 w-4" /> 拍一张
            </button>
            <button
              type="button"
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border bg-background text-sm font-medium active:bg-muted"
              onClick={() => {
                setPickerOpen(false);
                galleryRef.current?.click();
              }}
            >
              <ImageIcon className="h-4 w-4" /> 从相册选择（多选）
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
    </>
  );
}
