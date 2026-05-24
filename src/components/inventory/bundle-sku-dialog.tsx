import { useState, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Search, Trash2, Tags } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { createBundleSku, listSkus } from "@/lib/inventory.functions";
import { CATEGORY_LABEL, formatPrice } from "@/lib/inventory.helpers";
import { SkuMetaFields, emptySkuMeta, type SkuMetaState } from "./sku-meta-fields";

type ChildRow = {
  id: string;
  name: string;
  epc: string;
  category: string;
  price_tier: number;
  image_url: string | null;
  kind: string;
};

export function BundleSkuDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated?: () => void;
}) {
  const fn = useServerFn(createBundleSku);
  const [meta, setMeta] = useState<SkuMetaState>(emptySkuMeta);
  const [price, setPrice] = useState("");
  const [items, setItems] = useState<Array<{ sku: ChildRow; qty: number }>>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const reset = () => { setMeta(emptySkuMeta); setPrice(""); setItems([]); };

  const refSubtotal = useMemo(
    () => items.reduce((s, x) => s + x.qty * Number(x.sku.price_tier), 0),
    [items],
  );

  const addItems = (rows: ChildRow[]) => {
    setItems((cur) => {
      const map = new Map(cur.map((x) => [x.sku.id, x]));
      for (const r of rows) {
        if (!map.has(r.id)) map.set(r.id, { sku: r, qty: 1 });
      }
      return Array.from(map.values());
    });
  };

  const mut = useMutation({
    mutationFn: async () => {
      if (!meta.category || !meta.name.trim()) throw new Error("类目 / 品名 必填");
      const p = Number(price);
      if (!Number.isFinite(p) || p <= 0) throw new Error("请输入组包售价");
      if (items.length === 0) throw new Error("请至少添加一个子 SKU");
      return fn({
        data: {
          category: meta.category as never,
          name: meta.name.trim(),
          sku_code: meta.sku_code.trim() || null,
          weight_g: meta.weight ? Number(meta.weight) : null,
          image_url: meta.imageUrl.trim() || null,
          notes: meta.notes.trim() || null,
          price: Math.round(p * 100) / 100,
          items: items.map((x) => ({ sku_id: x.sku.id, qty: x.qty })),
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`已创建组包，EPC：${res.sku.epc}`);
      reset();
      onOpenChange(false);
      onCreated?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建组包商品</DialogTitle>
          <DialogDescription>
            把若干已有的标准/自定义商品组合成一个新的独立 SKU，库存独立维护
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2 md:grid-cols-2">
          <div>
            <SkuMetaFields state={meta} onChange={setMeta} />
            <div className="mt-3 space-y-1.5">
              <Label>组包售价 (¥) *</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="整包售价"
              />
              <p className="text-xs text-muted-foreground">
                子项参考总价：¥{refSubtotal.toFixed(2)}
                {price && Number(price) > 0 ? (
                  <> · 差额 {(Number(price) - refSubtotal).toFixed(2)}</>
                ) : null}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>包含子 SKU *</Label>
              <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> 添加子 SKU
              </Button>
            </div>
            {items.length === 0 ? (
              <Card className="flex h-40 items-center justify-center text-xs text-muted-foreground">
                还没有子项，点击右上「添加子 SKU」
              </Card>
            ) : (
              <ul className="divide-y rounded-lg border">
                {items.map(({ sku, qty }) => (
                  <li key={sku.id} className="flex items-center gap-2 p-2">
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                      {sku.image_url ? (
                        <img src={sku.image_url} alt={sku.name} className="h-full w-full object-cover" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          <Tags className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{sku.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {formatPrice(sku.price_tier)} · {sku.epc}
                      </p>
                    </div>
                    <Input
                      type="number"
                      min="1"
                      value={qty}
                      onChange={(e) =>
                        setItems((cur) =>
                          cur.map((x) =>
                            x.sku.id === sku.id ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x,
                          ),
                        )
                      }
                      className="h-8 w-16 text-xs"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setItems((cur) => cur.filter((x) => x.sku.id !== sku.id))}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground">
              合计 {items.reduce((s, x) => s + x.qty, 0)} 件
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "创建中…" : "创建组包并生成 EPC"}
          </Button>
        </DialogFooter>

        <ChildPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          excludeIds={items.map((x) => x.sku.id)}
          onConfirm={(rows) => { addItems(rows); setPickerOpen(false); }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ChildPickerDialog({
  open,
  onOpenChange,
  excludeIds,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  excludeIds: string[];
  onConfirm: (rows: ChildRow[]) => void;
}) {
  const listFn = useServerFn(listSkus);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [picked, setPicked] = useState<Record<string, ChildRow>>({});

  const q = useQuery({
    queryKey: ["bundle-child-picker", search],
    queryFn: () =>
      listFn({ data: { search: search || undefined, exclude_kind: "bundle", limit: 100 } }),
    enabled: open,
  });

  const rows = (q.data?.rows ?? []).filter((r) => !excludeIds.includes(r.id)) as ChildRow[];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setPicked({}); onOpenChange(v); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>选择子 SKU</DialogTitle>
          <DialogDescription>可多选，确认后将加入组包</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜品名 / EPC / 商品编码"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-lg border">
          {rows.length === 0 ? (
            <li className="p-8 text-center text-xs text-muted-foreground">
              {q.isLoading ? "加载中…" : "无可选 SKU"}
            </li>
          ) : (
            rows.map((r) => {
              const checked = !!picked[r.id];
              return (
                <li
                  key={r.id}
                  className="flex cursor-pointer items-center gap-2 p-2 hover:bg-muted/50"
                  onClick={() =>
                    setPicked((cur) => {
                      const next = { ...cur };
                      if (next[r.id]) delete next[r.id];
                      else next[r.id] = r;
                      return next;
                    })
                  }
                >
                  <input type="checkbox" checked={checked} readOnly className="h-4 w-4" />
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                    {r.image_url ? (
                      <img src={r.image_url} alt={r.name} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <Tags className="h-4 w-4" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{r.name}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {CATEGORY_LABEL[r.category] ?? r.category} · {formatPrice(r.price_tier)} · {r.epc}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{r.kind}</Badge>
                </li>
              );
            })
          )}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            disabled={Object.keys(picked).length === 0}
            onClick={() => { onConfirm(Object.values(picked)); setPicked({}); }}
          >
            添加 {Object.keys(picked).length || ""} 个
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
