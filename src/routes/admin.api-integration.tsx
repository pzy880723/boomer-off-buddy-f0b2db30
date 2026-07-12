import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Activity, CheckCircle2, Radio, Sparkles, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { ShopHealthPanel } from "@/components/youzan/shop-health-panel";
import { ApiHealthPanel } from "@/components/youzan/api-health-panel";
import { SyncCenterPanel } from "@/components/youzan/sync-center-panel";
import { MessagePushPanel } from "@/components/youzan/message-push-panel";
import { listYouzanSyncLogs, backfillShopOrders } from "@/lib/youzan.functions";

export const Route = createFileRoute("/admin/api-integration")({
  head: () => ({
    meta: [
      { title: "API 对接 · 系统" },
      { name: "description", content: "有赞及第三方 API 对接状态、体检与同步中心" },
    ],
  }),
  component: ApiIntegrationPage,
});

function ApiIntegrationPage() {
  const fetchLogs = useServerFn(listYouzanSyncLogs);
  const backfillFn = useServerFn(backfillShopOrders);

  const logsQ = useQuery({
    queryKey: ["youzan-sync-logs", "api-integration"],
    queryFn: () => fetchLogs({ data: { limit: 60 } }),
    refetchInterval: 10_000,
  });

  const backfillM = useMutation({
    mutationFn: () => backfillFn(),
    onSuccess: (r) => toast.success(`回填完成：扫描 ${r.scanned} · 更新 ${r.updated}`),
    onError: (e: Error) => toast.error(`回填失败：${e.message}`),
  });

  const logs = logsQ.data?.logs ?? [];

  return (
    <div className="container mx-auto space-y-6 px-4 py-6">
      <PageHeader
        title="API 对接"
        description="有赞及第三方 API 的授权状态、健康检查与同步中心"
      />

      <Tabs defaultValue="health">
        <TabsList>
          <TabsTrigger value="health">
            <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
            系统检查
          </TabsTrigger>
          <TabsTrigger value="api-health">
            <Activity className="mr-1.5 h-3.5 w-3.5" />
            API 体检
          </TabsTrigger>
          <TabsTrigger value="sync">
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            数据同步
          </TabsTrigger>
          <TabsTrigger value="realtime">
            <Radio className="mr-1.5 h-3.5 w-3.5" />
            实时推送
          </TabsTrigger>
          <TabsTrigger value="logs">
            <Activity className="mr-1.5 h-3.5 w-3.5" />
            同步明细
          </TabsTrigger>
          <TabsTrigger value="channel">
            <AlertCircle className="mr-1.5 h-3.5 w-3.5" />
            渠道同步异常
          </TabsTrigger>
        </TabsList>

        <TabsContent value="health" className="mt-3">
          <ShopHealthPanel />
        </TabsContent>
        <TabsContent value="api-health" className="mt-3">
          <ApiHealthPanel />
        </TabsContent>
        <TabsContent value="sync" className="mt-3">
          <SyncCenterPanel />
        </TabsContent>
        <TabsContent value="realtime" className="mt-3">
          <MessagePushPanel />
        </TabsContent>

        <TabsContent value="logs" className="mt-3 space-y-3">
          <div className="flex items-center justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => backfillM.mutate()}
              disabled={backfillM.isPending}
            >
              {backfillM.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              回填历史订单字段
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              <DataTable
                rowKey={(r) => r.id}
                data={logs}
                columns={[
                  {
                    header: "时间",
                    cell: (r) => (
                      <span className="font-mono text-xs tabular-nums">
                        {new Date(r.started_at).toLocaleString("zh-CN")}
                      </span>
                    ),
                  },
                  {
                    header: "kdt_id",
                    cell: (r) => (
                      <span className="font-mono text-xs tabular-nums">{r.kdt_id ?? "—"}</span>
                    ),
                  },
                  { header: "动作", cell: (r) => <span className="text-xs">{r.action}</span> },
                  {
                    header: "结果",
                    cell: (r) => (
                      <StatusBadge
                        tone={
                          r.status === "ok"
                            ? "success"
                            : r.status === "error"
                              ? "danger"
                              : "neutral"
                        }
                      >
                        {r.status}
                      </StatusBadge>
                    ),
                  },
                  {
                    header: "信息",
                    cell: (r) => (
                      <span
                        className="block max-w-[420px] truncate text-xs text-muted-foreground"
                        title={r.error ?? r.message ?? ""}
                      >
                        {r.error ?? r.message ?? "—"}
                      </span>
                    ),
                  },
                ]}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="channel" className="mt-3">
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              渠道同步异常记录已迁移至此。请前往{" "}
              <a href="/admin/channel-sync" className="text-primary underline">
                渠道同步异常明细页
              </a>{" "}
              查看详情。
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
