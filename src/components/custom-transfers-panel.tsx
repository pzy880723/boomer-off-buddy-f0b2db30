import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CustomTransferInput,
  TransferResult,
  TransferProduct,
} from "@/lib/custom-transfer-contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Call = (input: CustomTransferInput) => Promise<TransferResult>;
type CreateInput = Extract<CustomTransferInput, { action: "create" }>;
export class TransferRejected extends Error {}
const selectClass = "h-10 rounded-md border bg-background px-3 text-sm min-w-0";
const message = (e: unknown) => (e instanceof Error ? e.message : "网络异常，请重试");

export function CustomTransfersPanelView({
  actor,
  call,
  legacy,
}: {
  actor: string;
  call: Call;
  legacy?: React.ReactNode;
}) {
  const [status, setStatus] = useState<"all" | "in_transit" | "received">("all");
  const [location, setLocation] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState<string>();
  const cache = useQueryClient();
  const list = useQuery({
    queryKey: ["custom-transfers", actor, status, location, q, page],
    queryFn: () => call({ action: "list", status, location_id: location || undefined, q, page }),
    refetchInterval: 30_000,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: ["custom-transfers"] });
  return (
    <div className="space-y-5">
      <PageHeader
        title="商品调拨"
        description="自定义商品整件转移 · 拍照签收后入库 · 不需要 RFID"
      />
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex rounded-lg border p-1 gap-1">
          {(
            [
              ["all", "全部"],
              ["in_transit", "待签收"],
              ["received", "已签收"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={status === value ? "default" : "ghost"}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <select
          aria-label="涉及库位"
          className={selectClass}
          value={location}
          onChange={(e) => {
            setLocation(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部授权库位</option>
          {list.data?.locations?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <Input
          className="w-48"
          placeholder="搜索调拨单号"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        {list.data?.can_create && (
          <Button className="ml-auto" onClick={() => setCreate(true)}>
            新建调拨
          </Button>
        )}
      </div>
      {list.isPending && <p>正在加载调拨单…</p>}
      {list.error && (
        <p role="alert" className="text-destructive">
          {message(list.error)}{" "}
          <Button variant="outline" onClick={() => list.refetch()}>
            重试
          </Button>
        </p>
      )}
      {list.data?.items?.length === 0 && (
        <div className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          暂无相关调拨单
        </div>
      )}
      <div className="grid gap-3">
        {list.data?.items?.map((t) => (
          <button
            key={t.id}
            onClick={() => setDetail(t.id)}
            className="rounded-xl border bg-card p-5 text-left hover:border-primary focus-visible:ring-2 focus-visible:ring-primary"
          >
            <div className="flex justify-between gap-3 font-semibold">
              <span>{t.code}</span>
              <span className={t.status === "received" ? "text-emerald-700" : "text-amber-700"}>
                {t.status === "received" ? "已签收" : "待签收"}
              </span>
            </div>
            <p className="mt-3 font-medium">
              {t.from_name} → {t.to_name}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {t.lines
                .slice(0, 3)
                .map((l) => l.name)
                .join("、")}{" "}
              · 共 {t.qty} 件
            </p>
            <div className="mt-3 flex justify-between text-xs text-muted-foreground">
              <span>{new Date(t.created_at).toLocaleString("zh-CN")}</span>
              <span>查看详情 →</span>
            </div>
          </button>
        ))}
      </div>
      <div className="flex gap-3 items-center">
        <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span>第 {page} 页</span>
        <Button variant="outline" disabled={!list.data?.has_more} onClick={() => setPage(page + 1)}>
          下一页
        </Button>
      </div>
      {list.data?.can_create && legacy && (
        <details className="rounded-xl border p-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            旧调拨 / 销售损耗流水
          </summary>
          <div className="mt-5">{legacy}</div>
        </details>
      )}
      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新建商品调拨</DialogTitle>
          </DialogHeader>
          {create && list.data?.actor_id && (
            <CreateTransfer
              call={call}
              actor={list.data.actor_id}
              locations={list.data.locations ?? []}
              onCreated={(id) => {
                setCreate(false);
                setDetail(id);
                void refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>调拨详情 / 拍照签收</DialogTitle>
          </DialogHeader>
          {detail && (
            <TransferDetail
              key={detail}
              actor={actor}
              id={detail}
              call={call}
              onReceived={refresh}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateTransfer({
  call,
  actor,
  locations,
  onCreated,
}: {
  call: Call;
  actor: string;
  locations: NonNullable<TransferResult["locations"]>;
  onCreated: (id: string) => void;
}) {
  const key = `custom-transfer-pending:${actor}`;
  const [frozen, setFrozen] = useState<CreateInput | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  });
  const [from, setFrom] = useState(frozen?.from_location_id ?? locations[0]?.id ?? "");
  const [to, setTo] = useState(frozen?.to_location_id ?? "");
  const [notes, setNotes] = useState(frozen?.notes ?? "");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Record<string, TransferProduct>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const products = useQuery({
    queryKey: ["transfer-products", actor, from, q],
    queryFn: () => call({ action: "products", location_id: from, q }),
    enabled: !!from && !frozen,
  });
  const total =
    frozen?.lines.reduce((sum, l) => sum + l.qty, 0) ??
    Object.values(selected).reduce((sum, l) => sum + l.available_qty, 0);
  async function submit() {
    const input: CreateInput = frozen ?? {
      action: "create",
      client_op_id: crypto.randomUUID(),
      from_location_id: from,
      to_location_id: to,
      notes,
      lines: Object.values(selected).map((p) => ({ sku_id: p.sku_id, qty: p.available_qty })),
    };
    setBusy(true);
    setError("");
    try {
      // Persist the exact request before sending: uncertain retries must never create a second transfer.
      localStorage.setItem(key, JSON.stringify(input));
      setFrozen(input);
      const result = await call(input);
      if (!result.id) throw new Error("未收到单号，请使用同一请求重试确认");
      localStorage.removeItem(key);
      onCreated(result.id);
    } catch (e) {
      if (e instanceof TransferRejected) {
        localStorage.removeItem(key);
        setFrozen(null);
      }
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        发起后商品转为在途，原店停止销售；目标门店拍照签收后才计入库存。
      </p>
      {frozen && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          上次提交结果待确认，已保留原单据内容。请点击“重试确认”，不会重复扣减库存。
        </p>
      )}
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="grid gap-2 text-sm">
          调出库位
          <select
            disabled={busy || !!frozen}
            className={selectClass}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setSelected({});
              setQ("");
              if (to === e.target.value) setTo("");
            }}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-sm">
          调入库位
          <select
            disabled={busy || !!frozen}
            className={selectClass}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            <option value="">选择接收门店或仓库</option>
            {locations
              .filter((l) => l.id !== from)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {!frozen && (
        <>
          <Input
            placeholder="商品名称 / 编码 / 条码（可使用扫码枪）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            仅显示源库位可调的自定义商品。已被订单占用或多库位异常库存不显示；最多显示 100
            款，可搜索缩小范围。
          </p>
          {products.isPending && <p>加载商品…</p>}
          {products.error && <p role="alert">{message(products.error)}</p>}
          <div className="max-h-72 overflow-y-auto divide-y rounded-lg border">
            {products.data?.products?.map((p) => (
              <label key={p.sku_id} className="flex items-center gap-3 p-3 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={!!selected[p.sku_id]}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = { ...prev };
                      if (e.target.checked) next[p.sku_id] = p;
                      else delete next[p.sku_id];
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{p.name}</span>
                  <span className="block text-xs text-muted-foreground break-all">
                    {p.barcode || p.sku_code} · ¥{p.price.toFixed(2)}
                  </span>
                </span>
                <span className="text-sm whitespace-nowrap">{p.available_qty} 件</span>
              </label>
            ))}
            {products.data?.products?.length === 0 && (
              <p className="p-6 text-sm text-muted-foreground">此库位暂无符合条件的可调商品</p>
            )}
          </div>
          {Object.values(selected).length > 0 && (
            <p className="text-sm">
              已选：
              {Object.values(selected)
                .map((p) => p.name)
                .join("、")}
            </p>
          )}
        </>
      )}
      <label className="grid gap-2 text-sm">
        备注
        <Input
          maxLength={1000}
          disabled={busy || !!frozen}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="包装、交接等说明"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-background pt-4">
        <span>共 {total} 件</span>
        <Button disabled={busy || !from || !to || from === to || total === 0} onClick={submit}>
          {busy ? "正在确认…" : frozen ? "重试确认" : "发起调拨"}
        </Button>
      </div>
    </div>
  );
}

function TransferDetail({
  actor,
  id,
  call,
  onReceived,
}: {
  actor: string;
  id: string;
  call: Call;
  onReceived: () => unknown;
}) {
  const detail = useQuery({
    queryKey: ["custom-transfer-detail", actor, id],
    queryFn: () => call({ action: "detail", id }),
    refetchInterval: 15_000,
  });
  const t = detail.data?.transfer;
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (t)
      setPicked((prev) =>
        Array.from(new Set([...prev, ...t.photos.filter((p) => !p.used).map((p) => p.id)])).slice(
          0,
          6,
        ),
      );
  }, [t?.id]);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    if (picked.length + files.length > 6) {
      setError("每单最多选择 6 张照片");
      return;
    }
    setBusy(true);
    setError("");
    try {
      for (const file of Array.from(files)) {
        const base64 = await receiptImage(file);
        const r = await call({ action: "upload", id, image_base64: base64 });
        if (!r.photo) throw new Error("照片上传未确认，请刷新查看后重试");
        setPicked((prev) => [...prev, r.photo!.id]);
        await detail.refetch();
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function receive() {
    setBusy(true);
    setError("");
    try {
      await call({ action: "receive", id, photo_ids: picked });
      await detail.refetch();
      onReceived();
    } catch (e) {
      setError(message(e));
      await detail.refetch();
    } finally {
      setBusy(false);
    }
  }
  if (detail.error)
    return (
      <p role="alert">
        {message(detail.error)} <Button onClick={() => detail.refetch()}>重试</Button>
      </p>
    );
  if (!t) return <p>加载调拨单…</p>;
  const displayed = t.status === "received" ? t.photos.filter((p) => p.used) : t.photos;
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-muted/50 p-4">
        <p className="font-semibold">
          {t.code} · {t.status === "received" ? "已签收" : "待签收"}
        </p>
        <p className="mt-2">
          {t.from_name} → {t.to_name}
        </p>
        <p className="text-sm mt-2 text-muted-foreground">
          共 {t.qty} 件{t.notes && ` · ${t.notes}`}
        </p>
      </div>
      <div className="divide-y">
        {t.lines.map((l) => (
          <div key={l.sku_id} className="flex justify-between gap-4 py-3">
            <div>
              <p className="font-medium">{l.name}</p>
              <p className="text-xs text-muted-foreground break-all">
                {l.barcode || l.sku_code} · ¥{l.price.toFixed(2)}
              </p>
            </div>
            <span className="whitespace-nowrap">{l.qty} 件</span>
          </div>
        ))}
      </div>
      {t.status === "in_transit" && t.source_sync_pending && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          源店有赞库存正在清零，确认完成后才能签收。可先上传照片，稍后刷新重试。
        </p>
      )}
      {t.can_receive && (
        <>
          <p className="font-medium">签收照片</p>
          <p className="text-sm text-muted-foreground">
            核对实物后上传 1 至 6 张照片。有差异请暂不签收，联系发货门店。
          </p>
          <div className="flex flex-wrap gap-3">
            <label className="rounded-md border p-3 text-sm cursor-pointer">
              拍照
              <input
                aria-label="拍摄签收照片"
                className="sr-only"
                type="file"
                accept="image/*"
                capture="environment"
                disabled={busy}
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <label className="rounded-md border p-3 text-sm cursor-pointer">
              选择相册
              <input
                aria-label="上传签收照片"
                className="sr-only"
                type="file"
                accept="image/*"
                multiple
                disabled={busy}
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </>
      )}
      <div className="grid grid-cols-3 gap-3">
        {displayed.map((p) => (
          <div key={p.id} className="space-y-2">
            <button onClick={() => setPreview(p.url)} className="w-full">
              <img
                src={p.url}
                alt="签收凭证"
                className="aspect-square rounded-lg object-cover w-full"
              />
            </button>
            {t.can_receive && (
              <label className="flex gap-2 text-xs">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={picked.includes(p.id)}
                  onChange={(e) =>
                    setPicked((prev) =>
                      e.target.checked
                        ? [...prev, p.id].slice(0, 6)
                        : prev.filter((x) => x !== p.id),
                    )
                  }
                />
                用于本次签收
              </label>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {busy && (
        <p className="text-sm" role="status">
          正在保存，请勿重复提交…
        </p>
      )}
      {t.can_receive && (
        <Button
          className="w-full"
          disabled={busy || !picked.length || t.source_sync_pending}
          onClick={receive}
        >
          确认签收 · {t.qty} 件
        </Button>
      )}
      {t.received_at && (
        <p className="text-sm text-muted-foreground">
          签收时间：{new Date(t.received_at).toLocaleString("zh-CN")}
        </p>
      )}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>签收照片</DialogTitle>
          </DialogHeader>
          <img src={preview} alt="签收照片大图" className="max-h-[75dvh] object-contain w-full" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

async function receiptImage(file: File): Promise<string> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法读取照片，请重试");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
  } finally {
    image.close();
  }
}
