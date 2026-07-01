import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Trash2, Zap, CheckCircle2, AlertTriangle, ScanLine } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/page-header";
import { lookupSkusByEpcs, submitInbound } from "@/lib/inventory.functions";
import { CATEGORY_LABEL, formatPrice } from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/inbound/new")({
  head: () => ({
    meta: [{ title: "RFID 入库 · 库存" }],
  }),
  component: ScanInboundPage,
});

type SkuRow = {
  id: string;
  epc: string;
  category: string;
  price_tier: number;
  name: string;
  kind: "single" | "pack" | "bundle";
  pack_pieces: number | null;
  sku_code?: string | null;
  image_url: string | null;
};

function ScanInboundPage() {
  const nav = useNavigate();
  const lookupFn = useServerFn(lookupSkusByEpcs);
  const submitFn = useServerFn(submitInbound);

  const inputRef = useRef<HTMLInputElement>(null);
  const [buffer, setBuffer] = useState("");
  // epc -> qty
  const [scans, setScans] = useState<Map<string, number>>(new Map());
  // epc -> SkuRow | "unknown"
  const [skuCache, setSkuCache] = useState<Map<string, SkuRow | "unknown">>(new Map());
  const [unknownEpcs, setUnknownEpcs] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [operator, setOperator] = useState("");

  // 自动聚焦
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    focus();
    const id = window.setInterval(focus, 1500);
    return () => window.clearInterval(id);
  }, []);

  const addScan = async (raw: string) => {
    const epc = raw.trim();
    if (!epc) return;
    setScans((prev) => {
      const next = new Map(prev);
      next.set(epc, (next.get(epc) ?? 0) + 1);
      return next;
    });
    if (!skuCache.has(epc)) {
      try {
        const res = await lookupFn({ data: { epcs: [epc] } });
        const sku = (res.skus as SkuRow[]).find((s) => s.epc === epc);
        setSkuCache((prev) => {
          const next = new Map(prev);
          next.set(epc, sku ?? "unknown");
          return next;
        });
        if (!sku) {
          setUnknownEpcs((prev) => (prev.includes(epc) ? prev : [...prev, epc]));
          toast.warning(`未识别 EPC：${epc}`);
        }
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
  };

  const handleKey: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = buffer;
      setBuffer("");
      void addScan(v);
    }
  };

  // 按 SKU 聚合
  const aggregated = useMemo(() => {
    const map = new Map<string, { sku: SkuRow; qty: number; epcs: string[] }>();
    for (const [epc, qty] of scans) {
      const sku = skuCache.get(epc);
      if (sku && sku !== "unknown") {
        const cur = map.get(sku.id);
        if (cur) {
          cur.qty += qty;
          cur.epcs.push(epc);
        } else {
          map.set(sku.id, { sku, qty, epcs: [epc] });
        }
      }
    }
    return Array.from(map.values());
  }, [scans, skuCache]);

  const totalQty = aggregated.reduce((s, x) => s + x.qty, 0);
  const totalValue = aggregated.reduce(
    (s, x) => s + x.qty * Number(x.sku.price_tier),
    0,
  );

  const removeSku = (skuId: string, epcs: string[]) => {
    setScans((prev) => {
      const next = new Map(prev);
      for (const e of epcs) next.delete(e);
      return next;
    });
  };

  const removeUnknown = (epc: string) => {
    setScans((prev) => {
      const next = new Map(prev);
      next.delete(epc);
      return next;
    });
    setUnknownEpcs((prev) => prev.filter((e) => e !== epc));
  };

  const reset = () => {
    setScans(new Map());
    setSkuCache(new Map());
    setUnknownEpcs([]);
    setNotes("");
  };

  const submitMut = useMutation({
    mutationFn: () => {
      if (aggregated.length === 0) throw new Error("还没有扫到任何商品");
      return submitFn({
        data: {
          scans: aggregated.map((a) => ({ sku_id: a.sku.id, qty: a.qty })),
          operator: operator.trim() || null,
          notes: notes.trim() || null,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`入库成功：${res.total_qty} 件 · ¥${Number(res.total_value_cny).toFixed(2)}`);
      reset();
      nav({ to: "/inventory/inbound/$id", params: { id: res.order_id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4 pb-24">
      <Link to="/inventory/inbound" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-3 w-3" /> 入库记录
      </Link>

      <PageHeader
        title="RFID 入库"
        description="支持 RFID 手持机 / 台面读写器 / 扫描门：每读到一个 EPC 以回车结尾自动入队"
      />

      {/* 扫码输入 */}
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ScanLine className="h-4 w-4 text-primary" />
          扫描区
          <span className="ml-auto text-xs text-muted-foreground">
            {scans.size > 0 ? `已扫 ${scans.size} 个唯一 EPC` : "等待扫码…"}
          </span>
        </div>
        <Input
          ref={inputRef}
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          onKeyDown={handleKey}
          placeholder="点击聚焦后开始扫码，或手动输入 EPC + Enter"
          className="mt-3 h-12 font-mono text-base"
          autoFocus
        />
      </Card>

      {/* 实时汇总 */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 text-center">
          <p className="text-[10px] uppercase text-muted-foreground">总件数</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums">{totalQty}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] uppercase text-muted-foreground">总金额</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-primary">¥{totalValue.toFixed(2)}</p>
        </Card>
        <Card className="p-3 text-center">
          <p className="text-[10px] uppercase text-muted-foreground">SKU 种类</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums">{aggregated.length}</p>
        </Card>
      </div>

      {/* 未识别 EPC */}
      {unknownEpcs.length > 0 && (
        <Card className="border-warning/40 bg-warning/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warning-foreground">
            <AlertTriangle className="h-4 w-4" />
            未识别 EPC {unknownEpcs.length} 个
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {unknownEpcs.map((e) => (
              <Badge key={e} variant="outline" className="gap-1 font-mono">
                {e}
                <button onClick={() => removeUnknown(e)} className="ml-1 text-destructive">×</button>
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            这些 EPC 还没绑定 SKU，请先到 SKU 列表查找 / 创建并打印标签。
          </p>
        </Card>
      )}

      {/* 聚合明细 */}
      <Card className="overflow-hidden">
        <div className="border-b px-4 py-2 text-sm font-medium">扫描明细（按 SKU 聚合）</div>
        {aggregated.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted-foreground">还没扫到任何商品</div>
        ) : (
          <ul className="divide-y">
            {aggregated.map(({ sku, qty, epcs }) => (
              <li key={sku.id} className="flex items-center gap-3 px-4 py-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-muted">
                  {sku.image_url ? (
                    <img src={sku.image_url} alt={sku.name} className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{sku.name}</p>
                    {sku.kind === "pack" && <Badge variant="secondary" className="text-[10px]">组包·{sku.pack_pieces ?? "?"}</Badge>}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {CATEGORY_LABEL[sku.category] ?? sku.category} · {formatPrice(sku.price_tier)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold tabular-nums">×{qty}</p>
                  <p className="text-[11px] text-muted-foreground tabular-nums">
                    ¥{(qty * Number(sku.price_tier)).toFixed(2)}
                  </p>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeSku(sku.id, epcs)}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 备注 */}
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">操作员</label>
            <Input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="可选" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium">备注</label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="本次入库备注…" />
        </div>
      </Card>

      {/* 底部固定操作条 */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 backdrop-blur md:left-[var(--sidebar-width,16rem)]">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Button variant="outline" className="flex-1" onClick={reset} disabled={scans.size === 0}>
            清空
          </Button>
          <Button
            className="flex-[2] bg-gradient-brand hover:opacity-90"
            onClick={() => submitMut.mutate()}
            disabled={submitMut.isPending || aggregated.length === 0}
          >
            {submitMut.isPending ? (
              "提交中…"
            ) : (
              <>
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                完成入库 · {totalQty} 件 / ¥{totalValue.toFixed(2)}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
