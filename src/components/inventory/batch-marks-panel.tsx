// Four actions; confirmed writes and retries retain original operation/items/versions.
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { batchUpdateProductMarks } from "@/lib/product-marks-batch.functions";
import { generateWebProductCard } from "@/lib/product-card-web.functions";
import { FEATURED_STAMPS, FEATURED_STAMP_LABELS, NOTICE_TAGS, NOTICE_TAG_LABELS, type FeaturedStamp, type NoticeTag } from "@/lib/commerce/product-marks";
import { SKIP_REASON_LABELS, planMarkChange, type BatchMarkOp } from "@/lib/commerce/product-marks-batch";
import { BatchReceiptFence, confirmBatch, retryBatch, stampOperation, type ConfirmedBatch } from "@/lib/commerce/batch-confirmation";
import type { RecommendationCard } from "@/lib/recommendation-card";
import type { SkuRow } from "@/lib/inventory.helpers";

type OpKind = "card" | "fankuang" | "notice" | "stamp";
type ItemResult = { id: string; result: "success" | "unchanged" | "skipped" | "failed"; reason?: string; updated_at?: string };
const RESULT_LABEL = { success: "已修改", unchanged: "无需修改", skipped: "已跳过", failed: "失败" } as const;
const EXTRA_REASON: Record<string, string> = {
  no_permission: "无权限修改当前库位商品", not_found: "商品不存在",
  version_conflict: "商品已被修改；原版本重试不会覆盖，请关闭后重新选择确认",
  write_failed: "保存或结果核验失败，可按原版本重试",
};
const reasonText = (r?: string) => r ? (SKIP_REASON_LABELS as Record<string, string>)[r] ?? EXTRA_REASON[r] ?? "未知原因" : "";
const cards: Array<{ k: OpKind; title: string }> = [
  { k: "card", title: "生成商品卡" }, { k: "fankuang", title: "翻筐乐" },
  { k: "notice", title: "提示标签" }, { k: "stamp", title: "特色印章" },
];
export function BatchMarksPanel(props: {
  rows: SkuRow[]; selected: Set<string>; locationId: string; locationName: string; contextKey: string;
  onSelectedChange: (next: Set<string>) => void; onDone: () => void; onSaved: () => void;
}) {
  const batchFn = useServerFn(batchUpdateProductMarks);
  const cardFn = useServerFn(generateWebProductCard);
  const [op, setOp] = useState<OpKind | null>(null);
  const [add, setAdd] = useState<NoticeTag[]>([]);
  const [remove, setRemove] = useState<NoticeTag[]>([]);
  const [stamp, setStamp] = useState<FeaturedStamp | "nochange" | "clear">("nochange");
  const [fankuang, setFankuang] = useState<"in" | "out">("in");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [results, setResults] = useState<ItemResult[] | null>(null);
  const [generated, setGenerated] = useState<Record<string, RecommendationCard>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const confirmed = useRef<ConfirmedBatch | null>(null);
  const fence = useRef(new BatchReceiptFence());
  const context = useRef(props.contextKey);
  context.current = props.contextKey;
  useEffect(() => () => { fence.current.invalidate(); }, []);
  const selectedRows = useMemo(() => props.rows.filter((r) => props.selected.has(r.id)), [props.rows, props.selected]);
  const allSelected = props.rows.length > 0 && selectedRows.length === props.rows.length;
  const currentOp: BatchMarkOp | null = op === "stamp" ? stampOperation(stamp)
    : op === "fankuang" ? { kind: "fankuang", value: fankuang === "in" }
    : op === "notice" && add.length + remove.length ? { kind: "notice", add, remove } : null;
  const preview = { apply: 0, unchanged: 0, skipped: 0 };
  if (currentOp) for (const row of selectedRows) preview[planMarkChange(row, currentOp).outcome]++;
  const locked = busy || results !== null;
  const close = () => {
    if (busyRef.current) return;
    fence.current.invalidate(); setOp(null); confirmed.current = null;
    setGenerated({}); setCardErrors({});
  };
  const open = (kind: OpKind) => {
    if (busyRef.current) return;
    fence.current.invalidate(); confirmed.current = null; setOp(kind); setAdd([]); setRemove([]);
    setStamp("nochange"); setFankuang("in"); setResults(null); setGenerated({}); setCardErrors({});
  };
  const toggle = (list: NoticeTag[], set: (v: NoticeTag[]) => void, other: NoticeTag[], setOther: (v: NoticeTag[]) => void, tag: NoticeTag, on: boolean) => {
    if (locked) return;
    set(on ? [...list.filter((x) => x !== tag), tag] : list.filter((x) => x !== tag));
    if (on) setOther(other.filter((x) => x !== tag));
  };
  const submit = async (retry = false) => {
    if (busyRef.current) return;
    const original = confirmed.current;
    const request = retry && original ? retryBatch(original, results ?? [])
      : currentOp ? confirmBatch(props.locationId, currentOp, selectedRows.map((r) => ({ id: r.id, expected_updated_at: r.updated_at ?? "" }))) : null;
    if (!request?.items.length || request.items.some((i) => !i.expected_updated_at)) return;
    if (!retry) confirmed.current = request;
    const ticket = fence.current.begin(props.contextKey);
    busyRef.current = true; setBusy(true);
    try {
      const response = await batchFn({ data: request });
      if (!fence.current.accept(ticket, context.current)) return;
      const merged = new Map((results ?? []).map((r) => [r.id, r]));
      for (const result of response.results) merged.set(result.id, result);
      setResults([...merged.values()]);
      if (response.results.some((r) => r.result === "success")) props.onSaved();
      toast.success(`已核验 ${response.results.length} 件结果`);
    } catch (error) {
      if (!fence.current.accept(ticket, context.current)) return;
      // Fail closed on any request-level auth/network error: no cross-context retry.
      fence.current.invalidate(); confirmed.current = null; setOp(null); props.onSelectedChange(new Set());
      toast.error(error instanceof Error ? error.message : "批量操作已停止，请重新确认账号和当前库位");
    } finally {
      busyRef.current = false;
      if (fence.current.accept(ticket, context.current)) setBusy(false);
      else setBusy(false);
    }
  };
  const generateCards = async () => {
    if (busyRef.current) return;
    const items = selectedRows.map((r) => ({ id: r.id, name: r.name }));
    const location_id = props.locationId;
    const ticket = fence.current.begin(props.contextKey);
    busyRef.current = true; setBusy(true);
    for (const item of items) {
      if (!fence.current.accept(ticket, context.current)) break;
      try {
        const card = await cardFn({ data: { id: item.id, location_id } });
        if (!fence.current.accept(ticket, context.current)) break;
        setGenerated((prev) => ({ ...prev, [item.id]: card }));
      } catch {
        if (fence.current.accept(ticket, context.current)) setCardErrors((prev) => ({ ...prev, [item.id]: "生成停止，请确认账号和库位后重新选择" }));
        // Never continue to another SKU after an authentication/permission failure.
        break;
      }
    }
    busyRef.current = false;
    if (fence.current.accept(ticket, context.current)) setBusy(false);
  };
  const failed = (results ?? []).filter((r) => r.result === "failed").length;
  const nameOf = (id: string) => props.rows.find((r) => r.id === id)?.name ?? id;
  return (
    <section className="space-y-3 border-y py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{props.locationName} · 已选 {selectedRows.length} 件</span>
        <label className="flex items-center gap-2 text-xs"><Checkbox disabled={busy} checked={allSelected} onCheckedChange={(c) => props.onSelectedChange(c === true ? new Set(props.rows.map((r) => r.id)) : new Set())} />全选已加载（{props.rows.length}）</label>
        <Button disabled={busy} size="sm" variant="outline" className="ml-auto" onClick={props.onDone}>完成</Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">{cards.map((card) => <Button key={card.k} variant="outline" disabled={busy || selectedRows.length === 0} onClick={() => open(card.k)} className="h-14 justify-start">{card.title}</Button>)}</div>
      <Dialog open={op !== null} onOpenChange={(value) => { if (!value) close(); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto" onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }} onPointerDownOutside={(e) => { if (busy) e.preventDefault(); }}>
          <DialogHeader><DialogTitle>{op === "card" ? "商品卡文案预览" : cards.find((c) => c.k === op)?.title} · {props.locationName} · {selectedRows.length} 件</DialogTitle></DialogHeader>
          {op === "fankuang" && <RadioGroup disabled={locked} value={fankuang} onValueChange={(v) => setFankuang(v === "in" ? "in" : "out")}>
            <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="in" />加入翻筐乐</label>
            <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="out" />移出翻筐乐</label>
          </RadioGroup>}
          {op === "stamp" && <RadioGroup disabled={locked} value={stamp} onValueChange={(v) => { if (v === "nochange" || v === "clear" || (FEATURED_STAMPS as readonly string[]).includes(v)) setStamp(v as typeof stamp); }}>
            <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="nochange" />保持不变</label>
            {FEATURED_STAMPS.map((s) => <label key={s} className="flex items-center gap-2 text-sm"><RadioGroupItem value={s} />替换为{FEATURED_STAMP_LABELS[s]}</label>)}
            <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="clear" />明确清空特色印章</label>
          </RadioGroup>}
          {op === "notice" && <div className="space-y-3 text-sm">{(["add", "remove"] as const).map((mode) => <div key={mode}>
            <p className="mb-2 font-medium">{mode === "add" ? "追加" : "明确移除"}</p><div className="flex flex-wrap gap-3">{NOTICE_TAGS.map((t) => <label key={t} className="flex items-center gap-2">
              <Checkbox disabled={locked} checked={(mode === "add" ? add : remove).includes(t)} onCheckedChange={(c) => mode === "add" ? toggle(add, setAdd, remove, setRemove, t, c === true) : toggle(remove, setRemove, add, setAdd, t, c === true)} />{NOTICE_TAG_LABELS[t]}
            </label>)}</div></div>)}<p className="text-xs text-muted-foreground">“有瑕疵”新增将跳过，须逐件标注；功能冲突须明确移除另一项。</p></div>}
          {currentOp && !results && <p className="text-xs text-muted-foreground">预览：{op === "stamp" ? stamp === "clear" ? "将清空" : "将替换" : "将修改"} {preview.apply} 件 · 无需修改 {preview.unchanged} 件 · 跳过 {preview.skipped} 件</p>}
          {results && <div className="max-h-60 space-y-2 overflow-y-auto text-xs">{results.map((r) => <div key={r.id} className="flex justify-between gap-3"><span>{nameOf(r.id)}</span><span className={r.result === "failed" ? "text-destructive" : ""}>{RESULT_LABEL[r.result]}{r.reason ? `：${reasonText(r.reason)}` : ""}</span></div>)}</div>}
          {op === "card" && <div className="space-y-4">
            <p className="text-sm text-muted-foreground" role="note">仅临时文案预览，未生成完整商品卡，未保存到云端或入库；关闭即丢。商品卡制作与 A4 排版打印请使用原生手机现有流程。</p>
            {selectedRows.map((r) => { const card = generated[r.id]; return <div key={r.id} className="border-b pb-3 text-sm">
            <p className="font-medium">{r.name}</p>{card && <><p className="mt-2 font-semibold">{card.product_name} · {card.headline}</p><p>{card.keywords.join(" · ")}</p><p>{card.intro}</p><p>{card.highlights.join("；")}</p></>}
            {cardErrors[r.id] && <p role="alert" className="text-destructive">{cardErrors[r.id]}</p>}
          </div>; })}</div>}
          <DialogFooter>
            {op === "card" ? <Button disabled={busy || Object.keys(generated).length > 0 || Object.keys(cardErrors).length > 0} onClick={generateCards}>{busy ? "文案生成中…" : "生成临时文案"}</Button>
              : !results ? <Button disabled={busy || !currentOp || selectedRows.some((r) => !r.updated_at)} onClick={() => submit()}>{busy ? "处理中…" : "确认修改"}</Button>
              : failed > 0 && <Button variant="outline" disabled={busy} onClick={() => submit(true)}>按原确认版本重试失败 {failed} 件</Button>}
            <Button variant="outline" disabled={busy} onClick={close}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
