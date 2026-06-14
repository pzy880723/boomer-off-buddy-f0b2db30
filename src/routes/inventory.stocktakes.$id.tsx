import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  getStocktake,
  approveStocktake,
  rejectStocktake,
} from "@/lib/stocktake.functions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export const Route = createFileRoute("/inventory/stocktakes/$id")({
  component: StocktakeDetail,
});

function StocktakeDetail() {
  const { id } = Route.useParams();
  const router = useRouter();
  const qc = useQueryClient();
  const fn = useServerFn(getStocktake);
  const approve = useServerFn(approveStocktake);
  const reject = useServerFn(rejectStocktake);
  const q = useQuery({ queryKey: ["stocktake", id], queryFn: () => fn({ data: { id } }) });
  const [note, setNote] = useState("");

  if (q.isLoading) return <div className="p-6">加载中…</div>;
  if (!q.data) return <div className="p-6">未找到</div>;
  const { head, lines, unknown_scans } = q.data as any;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{head.code}</h1>
          <p className="text-sm text-muted-foreground">
            {head.location?.name} · <Badge>{head.status}</Badge>
          </p>
        </div>
        <Button variant="outline" onClick={() => router.history.back()}>返回</Button>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>系统数</TableHead>
              <TableHead>盘点数</TableHead>
              <TableHead>差异</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l: any) => (
              <TableRow key={l.id}>
                <TableCell>
                  <span className="font-mono text-xs text-muted-foreground mr-2">
                    {l.sku?.sku_code}
                  </span>
                  {l.sku?.name}
                </TableCell>
                <TableCell>{l.system_qty}</TableCell>
                <TableCell>{l.counted_qty}</TableCell>
                <TableCell>
                  <Badge variant={l.diff === 0 ? "outline" : l.diff > 0 ? "default" : "destructive"}>
                    {l.diff > 0 ? `+${l.diff}` : l.diff}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {unknown_scans.length > 0 && (
        <div className="rounded-md border bg-card p-4">
          <div className="text-sm font-medium mb-2">未识别 EPC ({unknown_scans.length})</div>
          <div className="text-xs font-mono space-x-2">
            {unknown_scans.slice(0, 50).map((u: any) => (
              <span key={u.epc} className="inline-block bg-muted px-2 py-0.5 rounded">
                {u.epc}
              </span>
            ))}
          </div>
        </div>
      )}

      {head.status === "submitted" && (
        <div className="rounded-md border bg-card p-4 space-y-3">
          <div className="text-sm font-medium">审核</div>
          <Textarea
            placeholder="审核备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                await approve({ data: { id, note: note || undefined } });
                toast.success("已通过，库存已调整");
                qc.invalidateQueries({ queryKey: ["stocktake", id] });
              }}
            >
              通过 + 调整库存
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await reject({ data: { id, note: note || undefined } });
                toast.success("已驳回");
                qc.invalidateQueries({ queryKey: ["stocktake", id] });
              }}
            >
              驳回
            </Button>
          </div>
          {head.review_note && (
            <div className="text-xs text-muted-foreground">备注：{head.review_note}</div>
          )}
        </div>
      )}
    </div>
  );
}
