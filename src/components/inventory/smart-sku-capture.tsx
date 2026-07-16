import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Camera, Upload, X, Loader2, Sparkles, SwitchCamera, RotateCcw } from "lucide-react";
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
  const [recognized, setRecognized] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 触发自动识别的 token：每次 shots 变化递增，handleAnalyze 防抖捕获最新 */
  const analyzeTokenRef = useRef(0);

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

  const removeShot = (i: number) => setShots((prev) => prev.filter((_, idx) => idx !== i));

  /** 清空照片与已填的智能字段，回到初始状态 */
  const restart = () => {
    setShots([]);
    setRecognized(false);
    onApply({
      imageUrl: "",
      category: "",
      name: "",
      notes: "",
      grade: "",
      attributes: {
        brand: null,
        maker: null,
        origin_region: null,
        origin_country: null,
        era: null,
        material: [],
        craft: [],
        object_type: null,
        colors: [],
        dimensions: null,
        functional_status: null,
        missing_parts: [],
      },
      recognitionRequestId: "",
      categoryConfidence: null,
      classificationStatus: "",
      aiSuggestedPrice: null,
      evidence: [],
    });
    toast.message("已清空，请重新拍摄");
  };

  const runAnalyze = useCallback(
    async (token: number, currentShots: { dataUrl: string; blob: Blob }[]) => {
      setAnalyzing(true);
      try {
        const urls = await Promise.all(currentShots.map((s) => uploadSkuImage(s.blob)));
        const images = await Promise.all(
          currentShots.map(async (s) => ({
            base64: await blobToBase64(s.blob),
            mime: s.blob.type || "image/jpeg",
          })),
        );
        const res = await recognizeFn({ data: { images } });
        // 若中途又拍了新照片，丢弃这次结果
        if (token !== analyzeTokenRef.current) return;
        if (!res.ok) {
          toast.warning("AI 识别失败，已保存照片，可手动补全");
          onApply({ imageUrl: urls[0] });
          setRecognized(true);
          return;
        }
        const f = res.fields;
        onApply({
          imageUrl: urls[0],
          category: f.category_code || "",
          name: f.name || "",
          notes: f.description || "",
          grade: f.condition_grade || "",
          attributes: f.attributes,
          recognitionRequestId: f.request_id,
          categoryConfidence: f.confidence,
          classificationStatus: f.status,
          aiSuggestedPrice: f.suggested_price_cny,
          evidence: f.evidence,
        });
        setRecognized(true);
        toast.success(
          f.status === "auto_classified"
            ? "已自动识别分类和商品字段"
            : "识别完成，请复核待确认分类",
        );
      } catch (e) {
        if (token === analyzeTokenRef.current) {
          toast.error((e as Error).message || "识别失败");
        }
      } finally {
        if (token === analyzeTokenRef.current) setAnalyzing(false);
      }
    },
    [onApply, recognizeFn],
  );

  // 自动识别：照片变化后防抖 600ms 触发；为 0 张时跳过
  useEffect(() => {
    if (shots.length === 0) {
      setRecognized(false);
      return;
    }
    analyzeTokenRef.current += 1;
    const token = analyzeTokenRef.current;
    const t = setTimeout(() => {
      runAnalyze(token, shots);
    }, 600);
    return () => clearTimeout(t);
  }, [shots, runAnalyze]);

  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" /> 智能新建
          {analyzing && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> 识别中
            </span>
          )}
          {!analyzing && recognized && <span className="ml-2 text-xs text-success">已识别</span>}
        </div>
        <div className="flex items-center gap-1">
          {shots.length > 0 && (
            <Button size="sm" variant="ghost" onClick={restart} title="清空重拍">
              <RotateCcw className="mr-1 h-3.5 w-3.5" /> 重拍
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {!streaming && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-white/80">
            <Camera className="h-7 w-7" />
            <span>点下方「开启摄像头」开始拍摄</span>
            <span className="text-[10px] opacity-70">拍完会自动识别</span>
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
        {analyzing && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> 识别中…
          </div>
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

      <div className="grid grid-cols-2 gap-2">
        {!streaming ? (
          <Button size="sm" variant="outline" onClick={() => startCamera()}>
            <Camera className="mr-1 h-4 w-4" /> 开启摄像头
          </Button>
        ) : (
          <Button size="sm" onClick={grab} disabled={shots.length >= MAX_SHOTS || analyzing}>
            <Camera className="mr-1 h-4 w-4" /> 拍照 ({shots.length}/{MAX_SHOTS})
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={shots.length >= MAX_SHOTS || analyzing}
        >
          <Upload className="mr-1 h-4 w-4" /> 上传图片
        </Button>
      </div>

      {recognized && !analyzing && (
        <Button size="sm" variant="secondary" className="w-full" onClick={onClose}>
          完成，去填价格
        </Button>
      )}

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
