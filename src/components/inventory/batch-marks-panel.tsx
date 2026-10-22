// 批量修改：翻筐乐 / 提示标签 / 特色印章。逐件结果（成功/未变化/跳过/失败），只重试失败项，保留已选。
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { batchUpdateProductMarks } from "@/lib/product-marks-batch.functions";
import {
  FEATURED_STAMPS, FEATURED_STAMP_LABELS, NOTICE_TAGS, NOTICE_TAG_LABELS, type FeaturedStamp, type NoticeTag,
} from "@/lib/commerce/product-marks";
import { SKIP_REASON_LABELS, planMarkChange, type BatchMarkOp } from "@/lib/commerce/product-marks-batch";
import type { SkuRow } from "@/lib/inventory.helpers";

type OpKind = "fankuang_in" | "fankuang_out" | "notice" | "stamp";
type ItemResult = { id: string; result: "success" | "unchanged" | "skipped" | "failed"; reason?: string; updated_at?: string };

const RESULT_LABEL = { success: "已修改", unchanged: "无需修改", skipped: "已跳过", failed: "失败" } as const;
const EXTRA_REASON: Record<string, string> = {
  no_permission: "无权限修改该商品（非本店或非总部/店长）",
  not_found: "商品不存在",
  version_conflict: "商品刚被他人修改，请重试",
  write_failed: "保存失败，请重试",
};
const reasonText = (r?: string) => (r ? (SKIP_REASON_LABELS as Record<string, string>)[r] ?? EXTRA_REASON[r] ?? "未知原因" : "");

export function BatchMarksPanel(props: {
  rows: SkuRow[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onDone: () => void;
  onSaved: () => void;
}) {
  const batchFn = useServerFn(batchUpdateProductMarks);
  const [op, setOp] = useState<OpKind | null>(null);
  const [add, setAdd] = useState<NoticeTag[]>([]);
  const [remove, setRemove] = useState<NoticeTag[]>([]);
  const [stamp, setStamp] = useState<FeaturedStamp | "">("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ItemResult[] | null>(null);
  const [versions, setVersions] = useState<Record<string, string>>({});

  const selectedRows = useMemo(() => props.rows.filter((r) => props.selected.has(r.id)), [props.rows, props.selected]);
  const allSelected = props.rows.length > 0 && selectedRows.length === props.rows.length;

  const buildOp = (): BatchMarkOp | null => {
    if (op === "fankuang_in") return { kind: "fankuang", value: true };
    if (op === "fankuang_out") return { kind: "fankuang", value: false };
    if (op === "notice") return add.length + remove.length ? { kind: "notice", add, remove } : null;
    if (op === "stamp") return { kind: "stamp", value: stamp || null };
    return null;
  };
  const currentOp = buildOp();
  const preview = useMemo(() => {
    const counts = { apply: 0, unchanged: 0, skipped: 0 };
    if (!currentOp) return counts;
    for (const r of selectedRows) counts[planMarkChange(r as never, currentOp).outcome] += 1;
    return counts;
  }, [selectedRows, currentOp]);

  const open = (k: OpKind) => { setOp(k); setAdd([]); setRemove([]); setStamp(""); setResults(null); };
  const toggle = (list: NoticeTag[], set: (v: NoticeTag[]) => void, other: NoticeTag[], setOther: (v: NoticeTag[]) => void, t: NoticeTag, on: boolean) => {
    set(on ? [...list.filter((x) => x !== t), t] : list.filter((x) => x !== t));
    if (on) setOther(other.filter((x) => x !== t));
  };

  const submit = async (ids: string[]) => {
    const opValue = buildOp();
    if (!opValue || ids.length === 0) return;
    setBusy(true);
    try {
      const rowsById = new Map(props.rows.map((r) => [r.id, r]));
      const res = await batchFn({ data: {
        op: opValue, location_id: null,
        items: ids.map((id) => ({ id, expected_updated_at: versions[id] ?? String((rowsById.get(id) as { updated_at?: string })?.updated_at ?? "") })),
      } });
      const merged = new Map((results ?? []).map((r) => [r.id, r]));
      for (const r of res.results as ItemResult[]) merged.set(r.id, r);
      setResults([...merged.values()]);
      setVersions((v) => ({ ...v, ...Object.fromEntries((res.results as ItemResult[]).filter((r) => r.updated_at).map((r) => [r.id, r.updated_at!])) }));
      const ok = (res.results as ItemResult[]).filter((r) => r.result === "success").length;
      if (ok) props.onSaved();
      toast.success(`已处理 ${ids.length} 件，修改成功 ${ok} 件`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "批量修改失败");
    } finally {
      setBusy(false);
    }
  };
  const failedIds = (results ?? []).filter((r) => r.result === "failed").map((r) => r.id);
  const nameOf = (id: string) => props.rows.find((r) => r.id === id)?.name ?? id;

  const cards: Array<{ k: OpKind; title: string; desc: string }> = [
    { k: "fankuang_in", title: "加入翻筐乐", desc: "仅自定义单件且有库存" },
    { k: "fankuang_out", title: "移出翻筐乐", desc: "明确不参与" },
    { k: "notice", title: "提示标签", desc: "默认追加，可明确移除" },
    { k: "stamp", title: "特色印章", desc: "单选替换或清空" },
  ];

  return (
    <Card className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">已选 {selectedRows.length} 件</span>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={allSelected} onCheckedChange={(c) => props.onSelectedChange(c === true ? new Set(props.rows.map((r) => r.id)) : new Set())} />
          全选已加载（{props.rows.length}）
        </label>
        <Button size="sm" variant="outline" className="ml-auto" onClick={props.onDone}>完成</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {cards.map((c) => (
          <button key={c.k} type="button" disabled={selectedRows.length === 0} onClick={() => open(c.k)}
            className="rounded-md border p-3 text-left transition-colors hover:bg-muted disabled:opacity-50">
            <p className="text-sm font-medium">{c.title}</p>
            <p className="text-xs text-muted-foreground">{c.desc}</p>
          </button>
        ))}
      </div>

      <Dialog open={op !== null} onOpenChange={(v) => !v && setOp(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{cards.find((c) => c.k === op)?.title} · {selectedRows.length} 件</DialogTitle></DialogHeader>
          {op === "notice" && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="mb-1.5 font-medium">追加</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {NOTICE_TAGS.map((t) => (
                    <label key={t} className="flex items-center gap-2">
                      <Checkbox checked={add.includes(t)} onCheckedChange={(c) => toggle(add, setAdd, remove, setRemove, t, c === true)} />
                      {NOTICE_TAG_LABELS[t]}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">“有瑕疵”需在商品详情逐件圈选图片，批量不会添加。</p>
              </div>
              <div>
                <p className="mb-1.5 font-medium">移除</p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {NOTICE_TAGS.map((t) => (
                    <label key={t} className="flex items-center gap-2">
                      <Checkbox checked={remove.includes(t)} onCheckedChange={(c) => toggle(remove, setRemove, add, setAdd, t, c === true)} />
                      {NOTICE_TAG_LABELS[t]}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          {op === "stamp" && (
            <ToggleGroup type="single" variant="outline" className="flex flex-wrap justify-start"
              value={stamp} onValueChange={(v) => setStamp((v as FeaturedStamp) || "")}>
              {FEATURED_STAMPS.map((s) => <ToggleGroupItem key={s} value={s} size="sm">{FEATURED_STAMP_LABELS[s]}</ToggleGroupItem>)}
            </ToggleGroup>
          )}
          {op === "stamp" && <p className="text-xs text-muted-foreground">{stamp ? `将替换为“${FEATURED_STAMP_LABELS[stamp]}”` : "未选择：将清空特色印章"}</p>}

          {currentOp && !results && (
            <p className="text-xs text-muted-foreground">预览：将修改 {preview.apply} 件 · 无需修改 {preview.unchanged} 件 · 跳过 {preview.skipped} 件（以服务端最终结果为准）</p>
          )}

          {results && (
            <div className="max-h-60 space-y-1 overflow-y-auto rounded border p-2 text-xs">
              {results.map((r) => (
                <div key={r.id} className="flex justify-between gap-2">
                  <span className="truncate">{nameOf(r.id)}</span>
                  <span className={r.result === "failed" ? "text-destructive" : r.result === "skipped" ? "text-muted-foreground" : ""}>
                    {RESULT_LABEL[r.result]}{r.reason ? `：${reasonText(r.reason)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            {results && failedIds.length > 0 && (
              <Button variant="outline" disabled={busy} onClick={() => submit(failedIds)}>重试失败的 {failedIds.length} 件</Button>
            )}
            {!results ? (
              <Button disabled={busy || !currentOp} onClick={() => submit(selectedRows.map((r) => r.id))}>{busy ? "处理中…" : "确认修改"}</Button>
            ) : (
              <Button onClick={() => setOp(null)}>关闭</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
