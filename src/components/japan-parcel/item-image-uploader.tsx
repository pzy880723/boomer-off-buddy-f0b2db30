import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, X, Loader2, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { toThumbUrl } from "@/lib/image";
import {
  compressImage,
  beginPendingUpload,
} from "@/lib/image-upload";
import { supabase } from "@/integrations/supabase/client";

const BUCKET = "parcel-item-images";

async function uploadCompressed(blob: Blob, ext: string, mime: string): Promise<string> {
  const path = `items/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    cacheControl: "3600",
    upsert: false,
    contentType: mime,
  });
  if (error) throw new Error(error.message);
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
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
  // 本地乐观预览（blob: URL），仅本组件可见；真正的持久 URL 通过 onChange 上抛
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0); // 0-100（假进度）
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }, []);

  useEffect(() => () => clearPreview(), [clearPreview]);

  const startFakeProgress = () => {
    setProgress(8);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      setProgress((p) => (p >= 90 ? p : p + Math.max(1, Math.round((90 - p) * 0.12))));
    }, 200);
  };
  const stopFakeProgress = (final: number) => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setProgress(final);
  };

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

      const t0 = performance.now();
      const originalSize = file.size;
      setUploading(true);
      startFakeProgress();

      let endPending: (() => void) | null = null;
      try {
        // 1) 压缩
        const { blob, ext, mime } = await compressImage(file, file.name);
        const t1 = performance.now();

        // 2) 立刻显示本地预览，让用户/表单感觉不到等待
        const objectUrl = URL.createObjectURL(blob);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = objectUrl;
        setPreviewUrl(objectUrl);

        // 3) 后台上传；期间标记 pending，让保存按钮禁用
        endPending = beginPendingUpload();
        const publicUrl = await uploadCompressed(blob, ext, mime);
        const t2 = performance.now();

        // 4) 交出真实 URL；预览释放（img 会自然切到公网图，切换时先保留 blob 避免闪白）
        onChange(publicUrl);
        // 稍后再 revoke，让 <img> 完成 src 切换
        setTimeout(() => {
          if (previewUrlRef.current === objectUrl) {
            URL.revokeObjectURL(objectUrl);
            previewUrlRef.current = null;
            setPreviewUrl(null);
          }
        }, 400);

        stopFakeProgress(100);
        console.debug(
          "[img] compress=%dms upload=%dms size=%dKB→%dKB",
          Math.round(t1 - t0),
          Math.round(t2 - t1),
          Math.round(originalSize / 1024),
          Math.round(blob.size / 1024),
        );
      } catch (e) {
        clearPreview();
        onChange(null);
        stopFakeProgress(0);
        toast.error((e as Error).message || "图片上传失败");
      } finally {
        endPending?.();
        setUploading(false);
        // 淡出进度条
        setTimeout(() => setProgress(0), 600);
      }
    },
    [onChange, clearPreview],
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

  // 显示优先级：本地预览 > 持久 URL
  const shownSrc = previewUrl ?? (value ? toThumbUrl(value, 256) ?? value : null);

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
        {shownSrc ? (
          <>
            <img
              src={shownSrc}
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
                  clearPreview();
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
          <>
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
              <div
                className="h-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            {!shownSrc && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            )}
          </>
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
        {uploading ? "上传中…" : value || previewUrl ? "替换图片" : "上传图片"}
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
