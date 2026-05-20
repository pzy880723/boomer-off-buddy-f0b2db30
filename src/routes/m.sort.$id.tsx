import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Loader2, Check, Printer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { MobileShell } from "@/components/mobile/mobile-shell";
import { getSortDetail, sortItemToSku, undoSortLabel, markParcelSorted } from "@/lib/mobile.functions";
import { toThumbUrl } from "@/lib/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INV_CATEGORIES, PRICE_TIERS } from "@/lib/inventory.helpers";

export const Route = createFileRoute("/m/sort/$id")({
  component: SortDetail,
});

function SortDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const fnDetail = useServerFn(getSortDetail);
  const fnSort = useServerFn(sortItemToSku);
  const fnUndo = useServerFn(undoSortLabel);
  const fnDone = useServerFn(markParcelSorted);

  const { data, isLoading } = useQuery({
    queryKey: ["sort-detail", id],
    queryFn: () => fnDetail({ data: { parcel_id: id } }),
  });

  const sortMut = useMutation({
    mutationFn: (input: Parameters<typeof fnSort>[0]["data"]) => fnSort({ data: input }),
    onSuccess: () => {
      toast.success("已生成 SKU + 标签批次");
      qc.invalidateQueries({ queryKey: ["sort-detail", id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const undoMut = useMutation({
    mutationFn: (batch_id: string) => fnUndo({ data: { batch_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sort-detail", id] }),
  });

  const doneMut = useMutation({
    mutationFn: () => fnDone({ data: { id } }),
    onSuccess: () => {
      toast.success("整包分拣完成");
      qc.invalidateQueries({ queryKey: ["sort-detail", id] });
    },
  });

  const labelsByItem = new Map<string, typeof data.labels>();
  (data?.labels ?? []).forEach((l) => {
    if (!l.parcel_item_id) return;
    if (!labelsByItem.has(l.parcel_item_id)) labelsByItem.set(l.parcel_item_id, []);
    labelsByItem.get(l.parcel_item_id)!.push(l);
  });

  return (
    <MobileShell title="分拣 · 贴标" back="/m/sort">
      {isLoading || !data ? (
        <div className="p-12 text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3 p-3">
          <div className="rounded-2xl border bg-card p-3 text-xs">
            <div className="font-medium">{data.parcel?.item_title_cn || data.parcel?.item_title}</div>
            <div className="mt-1 text-muted-foreground">
              {data.parcel?.tracking_no || data.parcel?.source_order_no}
            </div>
          </div>

          <ul className="space-y-2">
            {data.items.map((it) => (
              <SortItemRow
                key={it.id}
                item={it}
                existing={labelsByItem.get(it.id) ?? []}
                onSubmit={(payload) => sortMut.mutate(payload)}
                onUndo={(bid) => undoMut.mutate(bid)}
                pending={sortMut.isPending}
              />
            ))}
          </ul>

          <Button
            className="h-12 w-full"
            disabled={data.items.length === 0 || doneMut.isPending}
            onClick={() => doneMut.mutate()}
          >
            {doneMut.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
            标记整包分拣完成
          </Button>
        </div>
      )}
    </MobileShell>
  );
}

type Item = {
  id: string;
  item_title: string | null;
  item_title_cn: string | null;
  item_image_url: string | null;
  quantity: number | null;
  item_total_cny: number | null;
  weight_g: number | null;
  pack_pieces: number | null;
  tariff_category: string | null;
};

function SortItemRow({
  item,
  existing,
  onSubmit,
  onUndo,
  pending,
}: {
  item: Item;
  existing: Array<{ id: string; qty: number; status: string }>;
  onSubmit: (p: { parcel_item_id: string; category: string; price_tier: number; name: string; kind: "single" | "pack"; pack_pieces: number | null; image_url: string | null; weight_g: number | null; qty: number }) => void;
  onUndo: (batch_id: string) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(item.item_title_cn || item.item_title || "");
  const [category, setCategory] = useState<string>("daily");
  const [tier, setTier] = useState<number>(15.9);
  const [kind, setKind] = useState<"single" | "pack">(item.pack_pieces && item.pack_pieces > 1 ? "pack" : "single");
  const [packPieces, setPackPieces] = useState<number>(item.pack_pieces || 2);
  const [qty, setQty] = useState<number>(item.quantity || 1);

  return (
    <li className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-start gap-2 p-2.5">
        {item.item_image_url ? (
          <img
            src={toThumbUrl(item.item_image_url, 128) ?? item.item_image_url}
            alt=""
            className="h-12 w-12 flex-none rounded border object-cover"
            loading="lazy"
            width={48}
            height={48}
          />
        ) : (
          <div className="h-12 w-12 flex-none rounded border bg-muted" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{item.item_title_cn || item.item_title}</div>
          <div className="text-[10px] text-muted-foreground">
            ×{item.quantity ?? 1} · ¥{item.item_total_cny != null ? Number(item.item_total_cny).toFixed(2) : "—"}
          </div>
          {existing.length > 0 ? (
            <div className="mt-1 space-y-1">
              {existing.map((b) => (
                <div key={b.id} className="flex items-center gap-1 text-[10px]">
                  <Printer className="h-3 w-3 text-emerald-600" />
                  <span>已生成 {b.qty} 张标签</span>
                  <button
                    onClick={() => onUndo(b.id)}
                    className="ml-auto inline-flex items-center text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={open ? "secondary" : "outline"}
          className="h-7 px-2 text-[11px]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起" : "拆 SKU"}
        </Button>
      </div>
      {open ? (
        <div className="space-y-2 border-t bg-muted/30 p-2.5">
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
                parcel_item_id: item.id,
                category,
                price_tier: tier,
                name: name.trim(),
                kind,
                pack_pieces: kind === "pack" ? packPieces : null,
                image_url: item.item_image_url,
                weight_g: item.weight_g,
                qty,
              })
            }
          >
            {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Printer className="mr-1 h-3 w-3" />}
            生成 SKU + {qty} 张标签
          </Button>
        </div>
      ) : null}
    </li>
  );
}
