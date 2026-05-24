import { useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createStandardSkus } from "@/lib/inventory.functions";
import { generateEpc } from "@/lib/inventory.helpers";
import { PriceTierEditor } from "./price-tier-editor";
import { SkuMetaFields, emptySkuMeta, type SkuMetaState } from "./sku-meta-fields";

export function StandardSkuDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
}) {
  const fn = useServerFn(createStandardSkus);
  const [meta, setMeta] = useState<SkuMetaState>(emptySkuMeta);
  const [tiers, setTiers] = useState<number[]>([]);
  const [extraTiers, setExtraTiers] = useState<number[]>([]);
  const [adding, setAdding] = useState(false);
  const [newTierInput, setNewTierInput] = useState("");

  // 缓存 (category|tier) -> epc，避免重渲染时换随机串
  const epcCacheRef = useRef<Map<string, string>>(new Map());
  const epcKey = (cat: string, t: number) => `${cat}|${t}`;
  const getEpc = (cat: string, t: number) => {
    const k = epcKey(cat, t);
    const cached = epcCacheRef.current.get(k);
    if (cached) return cached;
    const v = generateEpc(cat, t);
    epcCacheRef.current.set(k, v);
    return v;
  };

  // 合并所有可选档：标准 + 自定义新增；按数字排序去重
  const allTierOptions = useMemo(() => {
    const set = new Set<number>([...PRICE_TIERS, ...extraTiers]);
    return Array.from(set).sort((a, b) => a - b);
  }, [extraTiers]);

  const toggleTier = (t: number) =>
    setTiers((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t].sort((a, b) => a - b)));

  const confirmAddTier = () => {
    const n = Number(newTierInput);
    if (!Number.isFinite(n) || n <= 0 || n > 9999.9) {
      toast.error("请输入 0~9999.9 之间的价格");
      return;
    }
    const rounded = Math.round(n * 10) / 10;
    if (Math.round(rounded * 10) !== rounded * 10) {
      toast.error("价格档最多保留 1 位小数");
      return;
    }
    if (!(PRICE_TIERS as readonly number[]).includes(rounded) && !extraTiers.includes(rounded)) {
      setExtraTiers((cur) => [...cur, rounded]);
    }
    // 自动勾选新加的档
    setTiers((cur) => (cur.includes(rounded) ? cur : [...cur, rounded].sort((a, b) => a - b)));
    setNewTierInput("");
    setAdding(false);
  };

  const sortedSelected = useMemo(() => [...tiers].sort((a, b) => a - b), [tiers]);

  const reset = () => {
    setMeta(emptySkuMeta);
    setTiers([]);
    setExtraTiers([]);
    setAdding(false);
    setNewTierInput("");
    epcCacheRef.current.clear();
  };

  const mut = useMutation({
    mutationFn: async () => {
      if (!meta.category || !meta.name.trim()) throw new Error("类目 / 品名 必填");
      if (sortedSelected.length === 0) throw new Error("至少选择一个价格档");
      const epc_map: Record<string, string> = {};
      for (const t of sortedSelected) epc_map[String(t)] = getEpc(meta.category, t);
      return fn({
        data: {
          category: meta.category as never,
          name: meta.name.trim(),
          sku_code: meta.sku_code.trim() || null,
          weight_g: meta.weight ? Number(meta.weight) : null,
          image_url: meta.imageUrl.trim() || null,
          notes: meta.notes.trim() || null,
          price_tiers: sortedSelected,
          epc_map,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`已创建 ${res.skus.length} 个标准 SKU`);
      reset();
      onOpenChange(false);
      onCreated?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建标准商品</DialogTitle>
          <DialogDescription>
            选中多个标准价格档将一次生成多条 SKU，共用品名、图片和商品编码
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <SkuMetaFields state={meta} onChange={setMeta} />
          <div className="space-y-2">
            <Label>标准价格档 *（可多选，可自定义新增）</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {allTierOptions.map((t) => {
                const active = tiers.includes(t);
                const isExtra = extraTiers.includes(t);
                return (
                  <Button
                    key={t}
                    type="button"
                    size="sm"
                    variant={active ? "default" : "outline"}
                    onClick={() => toggleTier(t)}
                  >
                    ¥{t}{isExtra && <span className="ml-1 text-[10px] opacity-70">新</span>}
                  </Button>
                );
              })}
              {adding ? (
                <div className="flex items-center gap-1">
                  <Input
                    autoFocus
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min="0"
                    value={newTierInput}
                    onChange={(e) => setNewTierInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); confirmAddTier(); }
                      if (e.key === "Escape") { setAdding(false); setNewTierInput(""); }
                    }}
                    placeholder="价格"
                    className="h-8 w-20 text-xs"
                  />
                  <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={confirmAddTier}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setAdding(false); setNewTierInput(""); }}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              已选 {sortedSelected.length} 档 → 将生成 {sortedSelected.length} 个 SKU
            </p>
          </div>

          {sortedSelected.length > 0 && meta.category && (
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">将生成的 SKU 编码（EPC）</p>
              <ul className="space-y-1">
                {sortedSelected.map((t) => (
                  <li key={t} className="flex items-center justify-between gap-2 text-xs">
                    <span className="tabular-nums font-medium">¥{t}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{getEpc(meta.category, t)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : `创建 ${sortedSelected.length || ""} 个 SKU`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
