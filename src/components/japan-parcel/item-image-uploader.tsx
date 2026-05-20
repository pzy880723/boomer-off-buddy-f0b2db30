import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, X, Loader2, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toThumbUrl } from "@/lib/image";

const BUCKET = "parcel-item-images";
const MAX_DIM = 1600;
const QUALITY = 0.82;
const SKIP_COMPRESS_BELOW = 200 * 1024; // 200KB

/**
 * 客户端压缩：长边缩到 MAX_DIM，编码 webp。
 * - 已经很小、GIF、SVG → 原样返回
 * - 任何失败 → 退回原 File
 */
async function compressImage(
  file: File,
): Promise<{ blob: Blob; ext: string; mime: string }> {
  const passthrough = () => ({
    blob: file,
    ext: (file.name.split(".").pop() || file.type.split("/").pop() || "png").toLowerCase(),
    mime: file.type || "application/octet-stream",
  });
  if (
    file.size < SKIP_COMPRESS_BELOW ||
    file.type === "image/gif" ||
    file.type === "image/svg+xml" ||
    !file.type.startsWith("image/")
  ) {
    return passthrough();
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    let blob: Blob | null = null;
    let mime = "image/webp";

    // OffscreenCanvas 优先（不阻塞主线程）
    if (typeof OffscreenCanvas !== "undefined") {
      try {
        const oc = new OffscreenCanvas(w, h);
        const ctx = oc.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0, w, h);
          try {
            blob = await oc.convertToBlob({ type: "image/webp", quality: QUALITY });
          } catch {
            blob = await oc.convertToBlob({ type: "image/jpeg", quality: 0.85 });
            mime = "image/jpeg";
          }
        }
      } catch {
        // ignore, fallback below
      }
    }

    // 普通 canvas 兜底
    if (!blob) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close?.();
        return passthrough();
      }
      ctx.drawImage(bitmap, 0, 0, w, h);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/webp", QUALITY),
      );
      if (!blob) {
        blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85),
        );
        mime = "image/jpeg";
      }
    }
    bitmap.close?.();

    if (!blob || blob.size >= file.size) return passthrough();
    return { blob, ext: mime === "image/webp" ? "webp" : "jpg", mime };
  } catch {
    return passthrough();
  }
}

async function uploadFile(file: File): Promise<string> {
  const { blob, ext, mime } = await compressImage(file);
  const path = `items/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    cacheControl: "3600",
    upsert: false,
    contentType: mime,
  });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export function ItemImageUploader({
  value,
  onChange,
  className,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  className?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("仅支持图片文件");
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        toast.error("原图需小于 20MB");
        return;
      }
      setUploading(true);
      try {
        const url = await uploadFile(file);
        onChange(url);
        toast.success("图片已上传");
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [onChange],
  );

  // 粘贴板事件：仅在组件 focus 时触发，避免与全局粘贴冲突
  useEffect(() => {
    if (!focused) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            void handleFile(f);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [focused, handleFile]);

  return (
    <div className={`flex flex-col items-center gap-1.5 ${className?.includes("h-16") ? "" : ""}`}>
      <div
        ref={boxRef}
        tabIndex={0}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
        className={`group relative flex h-28 w-28 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-dashed text-center text-[10px] outline-none transition-colors ${
          hover || focused ? "border-primary bg-primary/5" : "border-border bg-muted/30"
        } ${className ?? ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        {value ? (
          <>
            <img
              src={toThumbUrl(value, 256) ?? value}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
            {!uploading && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
                className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="移除图片"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-1 px-1 text-muted-foreground">
            <ImageIcon className="h-5 w-5" />
            <div>{focused ? "Ctrl+V 粘贴" : "点此后可粘贴"}</div>
            <div className="text-[9px] opacity-70">或拖拽图片到此</div>
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-28 px-2 text-[11px]"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
      >
        <Upload className="mr-1 h-3 w-3" />
        {value ? "替换图片" : "上传图片"}
      </Button>
    </div>
  );
}

// 紧凑版（用于详情页 64px 缩略图位置）
export function ItemImageUploaderCompact({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  return <ItemImageUploader value={value} onChange={onChange} className="h-16 w-16" />;
}
