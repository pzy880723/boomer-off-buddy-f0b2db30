import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Check, X, Minus, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getPriceTiers, setPriceTiers } from "@/lib/app-settings.functions";

export const PRICE_TIERS_QUERY_KEY = ["app-settings", "price-tiers"] as const;

export function PriceTierEditor({
  value,
  onChange,
}: {
  value: number[];
  onChange: (v: number[]) => void;
}) {
  const getFn = useServerFn(getPriceTiers);
  const setFn = useServerFn(setPriceTiers);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: PRICE_TIERS_QUERY_KEY,
    queryFn: () => getFn(),
  });
  const tiers = q.data?.tiers ?? [];

  const save = useMutation({
    mutationFn: (next: number[]) => setFn({ data: { tiers: next } }),
    onSuccess: (res) => {
      qc.setQueryData(PRICE_TIERS_QUERY_KEY, res);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const [adding, setAdding] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [editingTier, setEditingTier] = useState<number | null>(null);
  const [editInput, setEditInput] = useState("");
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const parsePrice = (raw: string): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 9999.9) return null;
    const r = Math.round(n * 10) / 10;
    if (Math.round(r * 10) !== r * 10) return null;
    return r;
  };

  const toggle = (t: number) =>
    onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t].sort((a, b) => a - b));

  const commitAdd = () => {
    const raw = addInput.trim();
    if (!raw) { setAdding(false); return; }
    const n = parsePrice(raw);
    if (n == null) { toast.error("价格 0~9999.9，最多 1 位小数"); return; }
    if (!tiers.includes(n)) {
      const next = [...tiers, n].sort((a, b) => a - b);
      save.mutate(next);
    }
    if (!value.includes(n)) onChange([...value, n].sort((a, b) => a - b));
    setAddInput("");
    setAdding(false);
  };

  const commitEdit = (old: number) => {
    const n = parsePrice(editInput);
    if (n == null) { toast.error("价格 0~9999.9，最多 1 位小数"); return; }
    if (n === old) { setEditingTier(null); return; }
    if (tiers.includes(n)) { toast.error("该价格已存在"); return; }
    const next = tiers.map((t) => (t === old ? n : t)).sort((a, b) => a - b);
    save.mutate(next);
    if (value.includes(old)) onChange(value.map((x) => (x === old ? n : x)).sort((a, b) => a - b));
    setEditingTier(null);
  };

  const confirmDelete = (t: number) => {
    const next = tiers.filter((x) => x !== t);
    save.mutate(next);
    if (value.includes(t)) onChange(value.filter((x) => x !== t));
    setPendingDelete(null);
  };

  // 自动聚焦编辑输入
  const editRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editingTier != null) editRef.current?.focus(); }, [editingTier]);

  const allSelected = tiers.length > 0 && tiers.every((t) => value.includes(t));
  const toggleAll = () => onChange(allSelected ? [] : [...tiers].sort((a, b) => a - b));

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {tiers.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant={allSelected ? "secondary" : "outline"}
            onClick={toggleAll}
            className="text-xs"
          >
            {allSelected ? "取消全选" : "全选"}
          </Button>
        )}

        {tiers.map((t) => {
          const active = value.includes(t);
          if (editingTier === t) {
            return (
              <div key={t} className="flex items-center gap-1">
                <Input
                  ref={editRef}
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  value={editInput}
                  onChange={(e) => setEditInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitEdit(t); }
                    if (e.key === "Escape") setEditingTier(null);
                  }}
                  onBlur={() => commitEdit(t)}
                  className="h-8 w-20 text-xs"
                />
              </div>
            );
          }
          return (
            <div key={t} className="group relative">
              <Button
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => toggle(t)}
                className="pr-2"
              >
                ¥{t}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditInput(String(t));
                    setEditingTier(t);
                  }}
                  className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded opacity-0 transition-opacity hover:bg-background/40 group-hover:opacity-70"
                  title="编辑"
                >
                  <Pencil className="h-2.5 w-2.5" />
                </button>
              </Button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setPendingDelete(t); }}
                className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-destructive hover:text-destructive-foreground group-hover:opacity-100"
                title="删除"
              >
                <Minus className="h-2.5 w-2.5" />
              </button>
            </div>
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
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitAdd(); }
                if (e.key === "Escape") { setAdding(false); setAddInput(""); }
              }}
              onBlur={commitAdd}
              placeholder="价格"
              className="h-8 w-20 text-xs"
            />
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={commitAdd}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setAdding(false); setAddInput(""); }}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <AlertDialog open={pendingDelete != null} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除价格档 ¥{pendingDelete}？</AlertDialogTitle>
            <AlertDialogDescription>
              此价格档为全局共用，删除后所有员工新建 SKU 的对话框都不会再显示此档。已经创建的 SKU 不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingDelete != null && confirmDelete(pendingDelete)}>
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
