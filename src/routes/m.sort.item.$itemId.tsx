import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Loader2, Check, Printer, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import {
  getPendingSortItem,
  sortItemToSku,
  undoSortLabel,
  markPendingSortItemDone,
} from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INV_CATEGORIES, PRICE_TIERS } from "@/lib/inventory.helpers";

export const Route = createFileRoute("/m/sort/item/$itemId")({
  component: SortItemDetail,
});

function SortItemDetail() {
  const { itemId } = Route.useParams();
  const qc = useQueryClient();
  const fnGet = useServerFn(getPendingSortItem);
  const fnSort = useServerFn(sortItemToSku);
  const fnUndo = useServerFn(undoSortLabel);
  const fnDone = useServerFn(markPendingSortItemDone);

  const { data, isLoading } = useQuery({
    queryKey: ["pending-sort-item", itemId],
    queryFn: () => fnGet({ data: { id: itemId } }),
  });

  type SortInput = {
    parcel_item_id: string;
    category: string;
    price_tier: number;
    name: string;
    kind: "single" | "pack";
    pack_pieces: number | null;
    image_url: string | null;
    weight_g: number | null;
    qty: number;
  };
  const sortMut = useMutation({
    mutationFn: (input: SortInput) => fnSort({ data: input }),
    onSuccess: () => {
      toast.success("已生成 SKU + 标签批次");
      qc.invalidateQueries({ queryKey: ["pending-sort-item", itemId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const undoMut = useMutation({
    mutationFn: (batch_id: string) => fnUndo({ data: { batch_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pending-sort-item", itemId] }),
  });

  const doneMut = useMutation({
    mutationFn: (action: "sorted" | "discarded") => fnDone({ data: { id: itemId, action } }),
    onSuccess: (_r, action) => {
      toast.success(action === "sorted" ? "袋子分拣完成" : "袋子已作废");
      qc.invalidateQueries({ queryKey: ["pending-sort-items"] });
      qc.invalidateQueries({ queryKey: ["pending-sort-item", itemId] });
    },
  });

  return (
    <MobileShell title="分拣 · 袋子" back="/m/sort">
      {isLoading || !data ? (
        <div className="p-12 text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3 p-3">
          <div className="flex items-start gap-3 rounded-2xl border bg-card p-3">
            {data.row.image_url ? (
              <img
                src={toThumbUrl(data.row.image_url, 192) ?? data.row.image_url}
                alt=""
                className="h-16 w-16 flex-none rounded border object-cover"
                loading="lazy"
              />
            ) : (
              <div className="h-16 w-16 flex-none rounded border bg-muted" />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{data.row.title || "(未命名)"}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {data.row.source_label || "—"}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                状态：{data.row.status === "pending" ? "待分拣" : data.row.status === "sorted" ? "已分拣" : "已作废"}
              </div>
            </div>
          </div>

          {data.labels.length > 0 ? (
            <div className="rounded-2xl border bg-card p-2.5">
              <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">已生成标签</div>
              <ul className="space-y-1.5">
                {data.labels.map((l) => {
                  const sku = (l as unknown as { inv_skus?: { name?: string; epc?: string } }).inv_skus;
                  return (
                    <li key={l.id} className="flex items-center gap-2 text-xs">
                      <Printer className="h-3 w-3 text-emerald-600" />
                      <span className="truncate">
                        {sku?.name ?? "—"} · {sku?.epc ?? ""} · ×{l.qty}
                      </span>
                      <button
                        onClick={() => undoMut.mutate(l.id)}
                        className="ml-auto inline-flex items-center text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <SortForm
            parcelItemId={data.row.parcel_item_id}
            defaultName={data.row.title ?? ""}
            defaultImage={data.row.image_url ?? null}
            pending={sortMut.isPending}
            onSubmit={(p) => sortMut.mutate(p)}
          />

          {data.row.status === "pending" ? (
            <div className="space-y-2">
              <Button
                className="h-12 w-full"
                disabled={doneMut.isPending}
                onClick={() => doneMut.mutate("sorted")}
              >
                <Check className="mr-1 h-4 w-4" /> 这个袋子分拣完成
              </Button>
              <Button
                variant="ghost"
                className="h-10 w-full text-destructive"
                disabled={doneMut.isPending}
                onClick={() => {
                  if (confirm("确认作废这个袋子？")) doneMut.mutate("discarded");
                }}
              >
                <X className="mr-1 h-4 w-4" /> 作废 / 丢弃
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </MobileShell>
  );
}

function SortForm({
  parcelItemId,
  defaultName,
  defaultImage,
  pending,
  onSubmit,
}: {
  parcelItemId: string;
  defaultName: string;
  defaultImage: string | null;
  pending: boolean;
  onSubmit: (p: {
    parcel_item_id: string;
    category: string;
    price_tier: number;
    name: string;
    kind: "single" | "pack";
    pack_pieces: number | null;
    image_url: string | null;
    weight_g: number | null;
    qty: number;
  }) => void;
}) {
  const [name, setName] = useState(defaultName);
  const [category, setCategory] = useState("daily");
  const [tier, setTier] = useState<number>(15.9);
  const [kind, setKind] = useState<"single" | "pack">("single");
  const [packPieces, setPackPieces] = useState<number>(2);
  const [qty, setQty] = useState<number>(1);

  return (
    <div className="space-y-2 rounded-2xl border bg-muted/30 p-2.5">
      <div className="text-[11px] font-medium text-muted-foreground">拆 SKU + 打 RFID</div>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-9 rounded border bg-background px-2 text-xs"
        >
          {INV_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          value={tier}
          onChange={(e) => setTier(Number(e.target.value))}
          className="h-9 rounded border bg-background px-2 text-xs"
        >
          {PRICE_TIERS.map((t) => (
            <option key={t} value={t}>
              ¥{t.toFixed(1)}
            </option>
          ))}
        </select>
      </div>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="SKU 名称"
        className="h-9 text-xs"
      />
      <div className="grid grid-cols-3 gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "single" | "pack")}
          className="h-9 rounded border bg-background px-2 text-xs"
        >
          <option value="single">单品</option>
          <option value="pack">组包</option>
        </select>
        {kind === "pack" ? (
          <Input
            type="number"
            value={packPieces}
            onChange={(e) => setPackPieces(Number(e.target.value) || 1)}
            placeholder="组件"
            className="h-9 text-xs"
          />
        ) : (
          <div />
        )}
        <Input
          type="number"
          value={qty}
          onChange={(e) => setQty(Number(e.target.value) || 1)}
          placeholder="标签份"
          className="h-9 text-xs"
        />
      </div>
      <Button
        size="sm"
        className="h-9 w-full text-xs"
        disabled={!name.trim() || pending}
        onClick={() =>
          onSubmit({
            parcel_item_id: parcelItemId,
            category,
            price_tier: tier,
            name: name.trim(),
            kind,
            pack_pieces: kind === "pack" ? packPieces : null,
            image_url: defaultImage,
            weight_g: null,
            qty,
          })
        }
      >
        {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Printer className="mr-1 h-3 w-3" />}
        生成 SKU + {qty} 张标签
      </Button>
    </div>
  );
}
