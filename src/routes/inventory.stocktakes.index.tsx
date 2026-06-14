import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listStocktakes } from "@/lib/stocktake.functions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/inventory/stocktakes/")({
  component: StocktakesPage,
});

const statusLabel: Record<string, string> = {
  scanning: "扫描中",
  submitted: "待审核",
  approved: "已通过",
  rejected: "已驳回",
};
const statusVariant = (s: string) =>
  s === "approved" ? "default" : s === "submitted" ? "secondary" : s === "rejected" ? "destructive" : "outline";

function StocktakesPage() {
  const list = useServerFn(listStocktakes);
  const q = useQuery({ queryKey: ["stocktakes"], queryFn: () => list() });
  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">盘点单</h1>
        <p className="text-sm text-muted-foreground">
          门店/仓库手持机提交后由总部审核。
        </p>
      </div>
      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>编号</TableHead>
              <TableHead>位置</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>开始</TableHead>
              <TableHead>提交</TableHead>
              <TableHead>审核</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data ?? []).map((s: any) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link to="/inventory/stocktakes/$id" params={{ id: s.id }} className="text-primary hover:underline font-mono text-xs">
                    {s.code}
                  </Link>
                </TableCell>
                <TableCell>{s.location?.name ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(s.status) as any}>
                    {statusLabel[s.status] ?? s.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">{new Date(s.opened_at).toLocaleString()}</TableCell>
                <TableCell className="text-xs">{s.submitted_at ? new Date(s.submitted_at).toLocaleString() : "—"}</TableCell>
                <TableCell className="text-xs">{s.reviewed_at ? new Date(s.reviewed_at).toLocaleString() : "—"}</TableCell>
              </TableRow>
            ))}
            {q.data && q.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                  暂无盘点单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
