// 阶段 8 · 渠道同步异常中心
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  listChannelSyncOutbox,
  retryChannelSyncTask,
  dismissChannelSyncTask,
  listSaleEvents,
} from "@/lib/omnichannel-ops.functions";

export const Route = createFileRoute("/admin/channel-sync")({
  head: () => ({
    meta: [{ title: "渠道同步异常中心 · ERP" }],
  }),
  component: Page,
});

function Page() {
  const [tab, setTab] = useState<"outbox" | "events">("outbox");
  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="渠道同步异常中心"
        description="监控 channel_sync_outbox 任务队列和 inventory_sale_events 销售事件，处理失败或未匹配的记录。"
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="outbox">同步任务队列</TabsTrigger>
          <TabsTrigger value="events">销售事件</TabsTrigger>
        </TabsList>
        <TabsContent value="outbox">
          <OutboxPanel />
        </TabsContent>
        <TabsContent value="events">
          <EventsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OutboxPanel() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"failed" | "pending" | "running" | "succeeded" | "all">("failed");
  const listFn = useServerFn(listChannelSyncOutbox);
  const retryFn = useServerFn(retryChannelSyncTask);
  const dismissFn = useServerFn(dismissChannelSyncTask);
  const q = useQuery({
    queryKey: ["outbox", status],
    queryFn: () => listFn({ data: { status, limit: 100 } }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => retryFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已重新入队");
      qc.invalidateQueries({ queryKey: ["outbox"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已丢弃");
      qc.invalidateQueries({ queryKey: ["outbox"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        <div className="flex gap-2 p-3 border-b">
          {(["failed", "pending", "running", "succeeded", "all"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? "default" : "outline"}
              onClick={() => setStatus(s)}
            >
              {s}
            </Button>
          ))}
          <div className="ml-auto">
            <Button size="sm" variant="ghost" onClick={() => q.refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead>动作 / 渠道</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>重试</TableHead>
              <TableHead>最后错误</TableHead>
              <TableHead>更新时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-6">
                  <Loader2 className="h-4 w-4 animate-spin inline" />
                </TableCell>
              </TableRow>
            ) : (q.data?.items ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-6 text-muted-foreground">
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
                    <div>{r.action}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.channel} · {r.target_stock ?? "-"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.status === "failed" || r.status === "dead" ? "destructive" : "secondary"}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.attempts}/{r.max_attempts}
                  </TableCell>
                  <TableCell className="text-xs max-w-xs truncate" title={r.last_error ?? ""}>
                    {r.last_error ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(r.updated_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button size="sm" variant="outline" onClick={() => retry.mutate(r.id)}>
                      <Play className="h-3 w-3 mr-1" /> 重试
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(r.id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function EventsPanel() {
  const [status, setStatus] = useState<"unmatched" | "oversold" | "failed" | "processed" | "all">(
    "unmatched",
  );
  const listFn = useServerFn(listSaleEvents);
  const q = useQuery({
    queryKey: ["sale-events", status],
    queryFn: () => listFn({ data: { status, limit: 100 } }),
  });
  return (
    <Card className="mt-4">
      <CardContent className="p-0">
        <div className="flex gap-2 p-3 border-b">
          {(["unmatched", "oversold", "failed", "processed", "all"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? "default" : "outline"}
              onClick={() => setStatus(s)}
            >
              {s}
            </Button>
          ))}
          <div className="ml-auto">
            <Button size="sm" variant="ghost" onClick={() => q.refetch()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>渠道 / 订单</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>错误</TableHead>
              <TableHead>接收时间</TableHead>
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
                    <div>{r.source_channel}</div>
                    <div className="text-xs text-muted-foreground">{r.source_order_id}</div>
                  </TableCell>
                  <TableCell className="text-xs">{r.event_type}</TableCell>
                  <TableCell className="text-xs">{r.sku_id ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        r.status === "unmatched" || r.status === "oversold" || r.status === "failed"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs max-w-xs truncate" title={r.error ?? ""}>
                    {r.error ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.received_at ? new Date(r.received_at).toLocaleString() : "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
