import { useState, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Printer, Package2, Tags } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { getSku, createLabelBatch } from "@/lib/inventory.functions";
import {
  CATEGORY_LABEL,
  SKU_KIND_LABEL,
  formatPrice,
  type SkuKind,
} from "@/lib/inventory.helpers";

export const Route = createFileRoute("/inventory/skus/$id")({
  component: SkuDetailPage,
});

function SkuDetailPage() {
  const { id } = Route.useParams();
  const getFn = useServerFn(getSku);
  const printFn = useServerFn(createLabelBatch);
  const [qty, setQty] = useState("10");
  const printRef = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ["inv-sku", id],
    queryFn: () => getFn({ data: { id } }),
  });

  const mut = useMutation({
    mutationFn: () => printFn({ data: { sku_id: id, qty: Number(qty) } }),
    onSuccess: () => {
      toast.success(`已记录打印 ${qty} 张，准备调起打印机…`);
      q.refetch();
      // delay so DOM updates with batch info
      setTimeout(() => window.print(), 200);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const sku = q.data?.sku;
  const labels = q.data?.labels ?? [];
  const lines = q.data?.lines ?? [];
  const bundleChildren = q.data?.bundle_children ?? [];

  if (q.isLoading) return <div className="p-6 text-muted-foreground">加载中…</div>;
  if (!sku) return <div className="p-6 text-muted-foreground">SKU 不存在</div>;

  const printCount = Math.max(1, Math.min(1000, Number(qty) || 0));
  const skuCode = (sku as { sku_code?: string | null }).sku_code;

  return (
    <div className="space-y-4">
      <Link to="/inventory/skus" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
        <ArrowLeft className="h-3 w-3" /> 返回 SKU 列表
      </Link>

      <PageHeader
        title={sku.name}
        description={`${CATEGORY_LABEL[sku.category] ?? sku.category} · ${SKU_KIND_LABEL[sku.kind as SkuKind] ?? sku.kind}${sku.kind === "pack" ? ` · 组包 ${sku.pack_pieces} 件` : ""}${sku.kind === "bundle" ? ` · 含 ${bundleChildren.length} 种子项` : ""}`}
        meta={
          <>
            <Badge className="bg-primary/90 text-primary-foreground">{formatPrice(sku.price_tier)}</Badge>
            <Badge variant="outline">库存 {sku.stock_qty} 件</Badge>
            <span className="font-mono text-[11px]">{sku.epc}</span>
            {skuCode && <span className="font-mono text-[11px] text-muted-foreground">商品编码：{skuCode}</span>}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="overflow-hidden">
          <div className="aspect-square bg-muted">
            {sku.image_url ? (
              <img src={sku.image_url} alt={sku.name} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                <Tags className="h-12 w-12" />
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          {sku.kind === "bundle" && bundleChildren.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-3 text-sm font-semibold">包含子项</h3>
              <ul className="divide-y">
                {bundleChildren.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 py-2">
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
                      {c.image_url ? <img src={c.image_url} alt={c.name} className="h-full w-full object-cover" /> : null}
                    </div>
                    <Link to="/inventory/skus/$id" params={{ id: c.id }} className="min-w-0 flex-1 hover:underline">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{formatPrice(c.price_tier)} · {c.epc}</p>
                    </Link>
                    <span className="text-sm font-bold tabular-nums">×{c.qty}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {/* 打印 RFID 标签 */}
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">RFID 标签打印</h3>
              <span className="text-xs text-muted-foreground">同 SKU 共用一个 EPC</span>
            </div>
            <div className="flex items-end gap-3">
              <div className="space-y-1.5">
                <Label>打印张数</Label>
                <Input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="w-32"
                />
              </div>
              <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
                <Printer className="mr-1.5 h-3.5 w-3.5" />
                {mut.isPending ? "提交中…" : "打印并记录"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              打印完成后请贴到商品上，然后到「扫枪入库」页扫码完成盘点入库。
            </p>
          </Card>

          {/* 打印记录 */}
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">最近打印记录</h3>
            <DataTable
              rowKey={(r: { id: string }) => r.id}
              data={labels as { id: string; qty: number; printed_at: string; status: string; operator: string | null }[]}
              columns={[
                {
                  header: "时间",
                  cell: (r) => (
                    <span className="text-xs tabular-nums">
                      {new Date(r.printed_at).toLocaleString("zh-CN")}
                    </span>
                  ),
                },
                { header: "数量", cell: (r) => `${r.qty} 张`, className: "tabular-nums" },
                { header: "状态", cell: (r) => <Badge variant="outline">{r.status}</Badge> },
                { header: "操作员", cell: (r) => r.operator ?? "-" },
              ]}
            />
          </Card>

          {/* 入库历史 */}
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <Package2 className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">入库历史</h3>
            </div>
            <DataTable
              rowKey={(r: { id: string }) => r.id}
              data={lines as { id: string; qty: number; unit_price: number; subtotal: number; created_at: string }[]}
              columns={[
                {
                  header: "时间",
                  cell: (r) => (
                    <span className="text-xs tabular-nums">
                      {new Date(r.created_at).toLocaleString("zh-CN")}
                    </span>
                  ),
                },
                { header: "件数", cell: (r) => `+${r.qty}`, className: "tabular-nums text-success" },
                { header: "单价", cell: (r) => `¥${Number(r.unit_price).toFixed(2)}`, className: "tabular-nums" },
                { header: "小计", cell: (r) => `¥${Number(r.subtotal).toFixed(2)}`, className: "tabular-nums" },
              ]}
            />
          </Card>
        </div>
      </div>

      {/* 打印预览区：window.print() 时只显示这块 */}
      <div ref={printRef} className="print-area hidden">
        <PrintLabels
          epc={sku.epc}
          name={sku.name}
          price={Number(sku.price_tier)}
          category={CATEGORY_LABEL[sku.category] ?? sku.category}
          count={printCount}
        />
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-area, .print-area * { visibility: visible; }
          .print-area { position: absolute; top: 0; left: 0; width: 100%; display: block !important; }
          .print-area .hidden { display: block !important; }
        }
      `}</style>
    </div>
  );
}

function PrintLabels({
  epc,
  name,
  price,
  category,
  count,
}: {
  epc: string;
  name: string;
  price: number;
  category: string;
  count: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "4mm",
        padding: "5mm",
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            border: "1px solid #000",
            borderRadius: "2mm",
            padding: "3mm",
            fontFamily: "sans-serif",
            color: "#000",
            background: "#fff",
            minHeight: "30mm",
          }}
        >
          <div style={{ fontSize: "9px", color: "#555" }}>{category}</div>
          <div style={{ fontSize: "13px", fontWeight: 700, margin: "1mm 0" }}>{name}</div>
          <div style={{ fontSize: "20px", fontWeight: 800 }}>¥{price.toFixed(2)}</div>
          <div style={{ fontFamily: "monospace", fontSize: "8px", marginTop: "1mm" }}>{epc}</div>
        </div>
      ))}
    </div>
  );
}
