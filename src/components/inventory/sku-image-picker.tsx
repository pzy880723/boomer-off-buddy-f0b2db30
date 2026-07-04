import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, X, Loader2, ImageIcon, Plus, Sparkles, Search } from "lucide-react";
import { toast } from "sonner";
import { compressImage, uploadSkuImage } from "@/lib/image-upload";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SkuImageSourceDialog } from "./sku-image-source-dialog";

export function SkuImagePicker({
  value,
  onChange,
  mobile,
  defaultName,
  defaultCategoryLabel,
}: {
  value: string;
  onChange: (url: string) => void;
  mobile?: boolean;
  defaultName?: string;
  defaultCategoryLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogTab, setDialogTab] = useState<"ai" | "search">("ai");

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
      setUploading(true);
      startFakeProgress();
      try {
        // 先压缩 + 立刻显示本地预览
        const { blob } = await compressImage(file, file.name);
        const objectUrl = URL.createObjectURL(blob);
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = objectUrl;
        setPreviewUrl(objectUrl);

        // 直接把已压缩好的 Blob 交给上传（uploadSkuImage 内部对小文件会跳过二次压缩）
        const url = await uploadSkuImage(blob);
        onChange(url);
        stopFakeProgress(100);
        setTimeout(() => {
          if (previewUrlRef.current === objectUrl) {
            URL.revokeObjectURL(objectUrl);
            previewUrlRef.current = null;
            setPreviewUrl(null);
          }
        }, 400);
      } catch (e) {
        clearPreview();
        stopFakeProgress(0);
        toast.error((e as Error).message || "上传失败，请重试");
      } finally {
        setUploading(false);
        setTimeout(() => setProgress(0), 600);
      }
    },
    [onChange, clearPreview],
  );

  const shownSrc = previewUrl ?? value;

  if (shownSrc) {
    return (
      <div className="relative h-32 w-32 overflow-hidden rounded-lg border bg-muted">
        <img src={shownSrc} alt="" className="h-full w-full object-cover" />
        {uploading && (
          <>
            <div className="absolute inset-0 bg-black/20" />
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/30">
              <div
                className="h-full bg-primary transition-[width] duration-200 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        )}
        {!uploading && (
          <button
            type="button"
            onClick={() => {
              clearPreview();
              onChange("");
            }}
            className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background"
            aria-label="移除图片"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={uploading}
            className="flex h-32 w-32 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed bg-muted/30 text-xs text-muted-foreground transition hover:bg-muted/60 disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                上传中… {progress}%
              </>
            ) : (
              <>
                <ImageIcon className="h-5 w-5" />
                <span className="inline-flex items-center gap-1">
                  <Plus className="h-3 w-3" /> 添加图片
                </span>
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => inputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" />本地上传
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setDialogTab("ai"); setDialogOpen(true); }}>
            <Sparkles className="mr-2 h-4 w-4" />AI 生成
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setDialogTab("search"); setDialogOpen(true); }}>
            <Search className="mr-2 h-4 w-4" />在线搜索
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture={mobile ? "environment" : undefined}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleFile(f);
        }}
      />

      <SkuImageSourceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialTab={dialogTab}
        defaultName={defaultName}
        defaultCategoryLabel={defaultCategoryLabel}
        onPick={onChange}
      />
    </>
  );
}

