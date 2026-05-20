import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Keyboard, Camera, Loader2, ScanLine } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchParcels, traceByEpc } from "@/lib/mobile.functions";

export const Route = createFileRoute("/m/scan")({
  component: ScanPage,
});

type Mode = "tracking" | "rfid" | "manual";

function ScanPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("tracking");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camOn, setCamOn] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const findParcels = useServerFn(searchParcels);
  const doTrace = useServerFn(traceByEpc);

  // 蓝牙扫枪：保持隐藏 input 聚焦，自动接管 keydown
  useEffect(() => {
    if (mode === "rfid") {
      hiddenRef.current?.focus();
    }
    return () => {
      stopRef.current?.();
    };
  }, [mode]);

  const handleResult = async (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setBusy(true);
    try {
      if (mode === "rfid" || v.toUpperCase().startsWith("INV-")) {
        const r = await doTrace({ data: { epc: v } });
        if (r.sku) {
          toast.success(`找到 SKU：${r.sku.name}`);
          router.navigate({ to: "/inventory/skus/$id", params: { id: r.sku.id } });
        } else {
          toast.error(`未匹配 EPC：${v}`);
        }
      } else {
        const r = await findParcels({ data: { q: v, limit: 5 } });
        if (r.rows.length === 1) {
          router.navigate({ to: "/m/receive/$id", params: { id: r.rows[0].id } });
        } else if (r.rows.length > 1) {
          router.navigate({ to: "/m/parcels", search: { } as never });
          toast.message(`匹配到 ${r.rows.length} 条，请在列表中确认`);
        } else {
          toast.error(`未找到包裹：${v}`);
        }
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setText("");
    }
  };

  // 摄像头条码识别（BarcodeDetector）
  async function startCamera() {
    const BD = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (s: HTMLVideoElement | ImageBitmap) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    if (!BD) {
      toast.error("当前浏览器不支持原生条码识别，请用蓝牙扫枪或手动输入");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCamOn(true);
      const detector = new BD({
        formats: ["code_128", "code_39", "ean_13", "ean_8", "qr_code", "itf", "upc_a", "upc_e"],
      });
      let stopped = false;
      const loop = async () => {
        if (stopped || !videoRef.current) return;
        try {
          const r = await detector.detect(videoRef.current);
          if (r && r[0]?.rawValue) {
            stopped = true;
            stream.getTracks().forEach((t) => t.stop());
            setCamOn(false);
            await handleResult(r[0].rawValue);
            return;
          }
        } catch {
          // ignore frame errors
        }
        requestAnimationFrame(loop);
      };
      stopRef.current = () => {
        stopped = true;
        stream.getTracks().forEach((t) => t.stop());
        setCamOn(false);
      };
      loop();
    } catch (e) {
      toast.error("摄像头无法启用：" + (e as Error).message);
    }
  }

  return (
    <MobileShell title="通用扫码" back>
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-3 gap-1.5 rounded-xl border bg-muted/30 p-1">
          {(
            [
              { v: "tracking", l: "运单/订单" },
              { v: "rfid", l: "RFID 枪" },
              { v: "manual", l: "手输" },
            ] as const
          ).map((m) => (
            <button
              key={m.v}
              onClick={() => setMode(m.v)}
              className={`rounded-lg py-2 text-xs font-medium transition-colors ${
                mode === m.v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {m.l}
            </button>
          ))}
        </div>

        {mode === "tracking" ? (
          <section className="space-y-3">
            <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border bg-black">
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                playsInline
                muted
              />
              {!camOn ? (
                <button
                  type="button"
                  onClick={startCamera}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-white"
                >
                  <Camera className="h-8 w-8" />
                  <span className="text-sm">点击启用摄像头识别条码</span>
                </button>
              ) : (
                <div className="pointer-events-none absolute inset-12 rounded-xl border-2 border-emerald-400/80" />
              )}
            </div>
            <div className="text-center text-[11px] text-muted-foreground">
              或直接在下方输入单号
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) handleResult(text);
              }}
            >
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="运单号 / 订单号"
                inputMode="search"
                autoFocus={!camOn}
              />
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
              </Button>
            </form>
          </section>
        ) : null}

        {mode === "rfid" ? (
          <section className="space-y-3">
            <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed bg-muted/30 text-muted-foreground">
              <Keyboard className="h-8 w-8" />
              <div className="text-sm font-medium">蓝牙扫枪已就绪</div>
              <div className="text-[11px]">扣动扳机扫 RFID 标签</div>
            </div>
            <input
              ref={hiddenRef}
              className="sr-only"
              autoFocus
              onBlur={() => setTimeout(() => hiddenRef.current?.focus(), 50)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.currentTarget as HTMLInputElement).value;
                  (e.currentTarget as HTMLInputElement).value = "";
                  if (v.trim()) handleResult(v);
                }
              }}
            />
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) handleResult(text);
              }}
            >
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="或手输 EPC（INV-XX-…）"
                inputMode="search"
              />
              <Button type="submit" disabled={busy}>查询</Button>
            </form>
          </section>
        ) : null}

        {mode === "manual" ? (
          <section className="space-y-3">
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) handleResult(text);
              }}
            >
              <Input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="粘贴运单号 / 订单号 / EPC"
                autoFocus
              />
              <Button type="submit" className="w-full h-11" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "查询"}
              </Button>
            </form>
          </section>
        ) : null}
      </div>
    </MobileShell>
  );
}
