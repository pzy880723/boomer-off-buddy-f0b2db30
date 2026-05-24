import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Camera, Upload, X, Loader2, Sparkles, SwitchCamera, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadSkuImage, blobToBase64 } from "@/lib/image-upload";
import { recognizeSkuFromPhotos } from "@/lib/ai.functions";
import type { SkuMetaState } from "./sku-meta-fields";

const MAX_SHOTS = 5;

export function SmartSkuCapture({
  onApply,
  onClose,
}: {
  /** AI 识别完成后调用，传入要 merge 进表单的字段 */
  onApply: (patch: Partial<SkuMetaState>) => void;
  onClose: () => void;
}) {
  const recognizeFn = useServerFn(recognizeSkuFromPhotos);
  const [streaming, setStreaming] = useState(false);
  const [shots, setShots] = useState<{ dataUrl: string; blob: Blob }[]>([]);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [analyzing, setAnalyzing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStreaming(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const startCamera = async (mode: "environment" | "user" = facing) => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      toast.error("当前浏览器不支持调用摄像头，请改用上传");
      return;
    }
    try {
      const stream = await md.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      stopCamera();
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStreaming(true);
      setFacing(mode);
    } catch (e) {
      toast.error((e as Error).message || "无法启动摄像头");
    }
  };

  const switchCam = () => startCamera(facing === "environment" ? "user" : "environment");

  const grab = async () => {
    if (!videoRef.current) return;
    const v = videoRef.current;
    const maxW = 1280;
    let w = v.videoWidth;
    let h = v.videoHeight;
    if (w > maxW) {
      h = (h * maxW) / w;
      w = maxW;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) =>
      canvas.toBlob((b) => r(b), "image/jpeg", 0.85),
    );
    if (!blob) return;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setShots((prev) => {
      if (prev.length >= MAX_SHOTS) {
        toast.message(`最多 ${MAX_SHOTS} 张`);
        return prev;
      }
      return [...prev, { dataUrl, blob }];
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const remain = MAX_SHOTS - shots.length;
    const picked = arr.slice(0, remain);
    const next: { dataUrl: string; blob: Blob }[] = [];
    for (const f of picked) {
      const dataUrl: string = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ""));
        r.readAsDataURL(f);
      });
      next.push({ dataUrl, blob: f });
    }
    setShots((prev) => [...prev, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const removeShot = (i: number) =>
    setShots((prev) => prev.filter((_, idx) => idx !== i));

  const handleAnalyze = async () => {
    if (shots.length === 0) {
      toast.error("请至少拍 / 选 1 张照片");
      return;
    }
    setAnalyzing(true);
    try {
      // 1) 上传所有照片
      const urls = await Promise.all(shots.map((s) => uploadSkuImage(s.blob)));
      // 2) AI 识别（用 base64，避免外网回源延迟）
      const images = await Promise.all(
        shots.map(async (s) => ({
          base64: await blobToBase64(s.blob),
          mime: s.blob.type || "image/jpeg",
        })),
      );
      const res = await recognizeFn({ data: { images } });
      if (!res.ok) {
        toast.warning("AI 识别失败，已为你保存照片，请手动补全字段");
        onApply({ imageUrl: urls[0] });
        onClose();
        return;
      }
      const f = res.fields;
      onApply({
        imageUrl: urls[0],
        category: f.category || "",
        name: f.name || "",
        notes: f.description || "",
        grade: f.grade || "",
      });
      toast.success("已自动填充，可微调后保存");
      onClose();
    } catch (e) {
      toast.error((e as Error).message || "识别失败");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" /> 智能新建
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
        />
        {!streaming && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-white/80">
            <Camera className="h-7 w-7" />
            <span>点下方「开启摄像头」开始拍摄</span>
          </div>
        )}
        {streaming && (
          <button
            type="button"
            onClick={switchCam}
            className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white"
            aria-label="切换前后镜头"
          >
            <SwitchCamera className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 缩略图列 */}
      {shots.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {shots.map((s, i) => (
            <div key={i} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border">
              <img src={s.dataUrl} alt="" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => removeShot(i)}
                className="absolute right-0 top-0 inline-flex h-5 w-5 items-center justify-center rounded-bl-md bg-background/90 text-foreground"
                aria-label="删除"
              >
                <X className="h-3 w-3" />
              </button>
              {i === 0 && (
                <span className="absolute bottom-0 left-0 right-0 bg-primary/90 text-center text-[10px] text-primary-foreground">
                  封面
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {!streaming ? (
          <Button size="sm" variant="outline" onClick={() => startCamera()} className="col-span-1">
            <Camera className="mr-1 h-4 w-4" /> 开启
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={grab}
            disabled={shots.length >= MAX_SHOTS}
            className="col-span-1"
          >
            <Camera className="mr-1 h-4 w-4" /> 拍 ({shots.length}/{MAX_SHOTS})
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={shots.length >= MAX_SHOTS}
          className="col-span-1"
        >
          <Upload className="mr-1 h-4 w-4" /> 上传
        </Button>
        <Button
          size="sm"
          onClick={handleAnalyze}
          disabled={analyzing || shots.length === 0}
          className="col-span-1"
        >
          {analyzing ? (
            <>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" /> 识别…
            </>
          ) : (
            <>
              <Check className="mr-1 h-4 w-4" /> 识别填充
            </>
          )}
        </Button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}
