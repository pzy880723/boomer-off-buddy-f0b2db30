// 阶段 6 · 退货复检工作台
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listReturnInspections,
  completeReturnInspection,
} from "@/lib/omnichannel-ops.functions";
import { listLocations } from "@/lib/locations.functions";

export const Route = createFileRoute("/inventory/return-inspection")({
  head: () => ({
    meta: [{ title: "退货复检 · ERP" }],
  }),
  component: Page,
});

type Filter = "pending" | "pass" | "fail" | "all";

function Page() {
  const [status, setStatus] = useState<Filter>("pending");
  const qc = useQueryClient();
  const listFn = useServerFn(listReturnInspections);
  const locFn = useServerFn(listLocations);
  const completeFn = useServerFn(completeReturnInspection);
  const q = useQuery({
    queryKey: ["return-inspections", status],
    queryFn: () => listFn({ data: { status, limit: 100 } }),
  });
  const locsQ = useQuery({ queryKey: ["locations"], queryFn: () => locFn() });
  type Row = NonNullable<typeof q.data>["items"][number];
  const [open, setOpen] = useState<Row | null>(null);
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [locId, setLocId] = useState<string>("");
  const [notes, setNotes] = useState("");

  const mut = useMutation({
    mutationFn: (payload: { inspection_id: string; result: "pass" | "fail"; location_id?: string; notes?: string }) =>
      completeFn({ data: payload }),
    onSuccess: () => {
      toast.success("复检已提交");
      qc.invalidateQueries({ queryKey: ["return-inspections"] });
      setOpen(null);
      setNotes("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="退货复检"
        description="有赞订单退款后，系统会创建复检待办；复检通过后才回补库存并重新上架。"
      />
      <div className="flex items-center gap-2">
        <Tabs value={status} onValueChange={(v) => setStatus(v as Filter)}>
          <TabsList>
            <TabsTrigger value="pending">待复检</TabsTrigger>
            <TabsTrigger value="pass">已通过</TabsTrigger>
            <TabsTrigger value="fail">已判废</TabsTrigger>
            <TabsTrigger value="all">全部</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>渠道 / 订单</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>回补</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin inline" />
                  </TableCell>
                </TableRow>
              ) : (q.data?.items ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                    暂无记录
                  </TableCell>
                </TableRow>
              ) : (
                q.data?.items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium">{r.sku?.name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{r.sku?.sku_code ?? r.sku_id}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{r.refund_source_channel ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{r.refund_source_order_id ?? "—"}</div>
                    </TableCell>
                    <TableCell>
                      {r.inspection_result === "pass" ? (
                        <Badge variant="default">通过</Badge>
                      ) : r.inspection_result === "fail" ? (
                        <Badge variant="destructive">判废</Badge>
                      ) : (
                        <Badge variant="secondary">待复检</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.channel_restore_status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {!r.inspection_result ? (
                        <Button
                          size="sm"
                          onClick={() => {
                            setOpen(r);
                            setResult("pass");
                            setLocId("");
                            setNotes("");
                          }}
                        >
                          复检
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">已处理</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>复检 · {open?.sku?.name ?? ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm mb-1 block">结果</label>
              <Select value={result} onValueChange={(v) => setResult(v as "pass" | "fail")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">
                    <CheckCircle2 className="h-4 w-4 inline mr-1 text-green-600" />
                    通过 · 回补 + 重新上架
                  </SelectItem>
                  <SelectItem value="fail">
                    <XCircle className="h-4 w-4 inline mr-1 text-red-600" />
                    判废 · 不回补
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {result === "pass" && (
              <div>
                <label className="text-sm mb-1 block">回补库位</label>
                <Select value={locId} onValueChange={setLocId}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择库位" />
                  </SelectTrigger>
                  <SelectContent>
                    {(locsQ.data ?? []).map((loc) => (
                      <SelectItem key={loc.id} value={loc.id}>
                        {loc.kind} · {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <label className="text-sm mb-1 block">备注（可选）</label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              取消
            </Button>
            <Button
              disabled={mut.isPending || (result === "pass" && !locId)}
              onClick={() =>
                open &&
                mut.mutate({
                  inspection_id: open.id,
                  result,
                  location_id: result === "pass" ? locId : undefined,
                  notes: notes || undefined,
                })
              }
            >
              {mut.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              提交
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
