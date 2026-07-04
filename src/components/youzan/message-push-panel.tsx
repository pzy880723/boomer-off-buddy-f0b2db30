import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Copy,
  CheckCircle2,
  Circle,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Radio,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { StatusBadge } from "@/components/status-badge";
import { getMessagePushStats } from "@/lib/youzan-message-push.functions";

const PUSH_URL =
  "https://boomer-off-buddy.lovable.app/api/public/hooks/youzan-message";

const EVENTS: Array<{ code: string; label: string; note: string }> = [
  { code: "TRADE_TradePaid", label: "订单已付款", note: "扣本地库存（核心）" },
  { code: "TRADE_TradeSuccess", label: "订单已完成", note: "兜底扣库存" },
  { code: "REFUND_RefundSuccess", label: "退款成功", note: "回补本地库存（核心）" },
  { code: "REFUND_SellerAgree", label: "卖家同意退款", note: "兜底回补" },
];

function relativeTime(iso: string | null) {
  if (!iso) return "从未收到";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

export function MessagePushPanel() {
  const fetchStats = useServerFn(getMessagePushStats);
  const q = useQuery({
    queryKey: ["youzan-message-push-stats"],
    queryFn: () => fetchStats(),
    refetchInterval: 5_000,
  });

  const last = q.data?.lastReceivedAt ?? null;
  const active =
    !!last && Date.now() - new Date(last).getTime() < 30 * 60 * 1000;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(PUSH_URL);
      toast.success("推送 URL 已复制");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <div className="space-y-4">
      {/* 状态灯 + URL */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            {active ? (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10">
                <Radio className="h-5 w-5 text-emerald-500" />
              </div>
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Circle className="h-5 w-5 text-muted-foreground" />
              </div>
            )}
            <div>
              <div className="text-sm font-medium">
                {active ? "已联通 · 有赞推送正常" : "尚未收到有赞推送"}
              </div>
              <div className="text-xs text-muted-foreground">
                最近一次推送：{relativeTime(last)} · 24h 内 {q.data?.total24h ?? 0} 条
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
            <span className="max-w-[420px] truncate">{PUSH_URL}</span>
            <Button size="sm" variant="ghost" onClick={copyUrl}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 3 步引导 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">3 步在有赞云后台配置消息推送</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Step n={1} title="打开有赞云 → 应用中心 → 中古ERP系统 → 消息订阅">
            <a
              href="https://www.youzanyun.com/dashboard/openv2/app"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              打开有赞云 <ExternalLink className="h-3 w-3" />
            </a>
          </Step>
          <Step
            n={2}
            title="「正式店铺推送网址」→ 点『修改』→ 粘贴上面复制的 URL → 保存"
          >
            推送方式选 <span className="font-mono">http调用</span>。改完最长 3 分钟生效。
          </Step>
          <Step
            n={3}
            title="打开右上角『消息推送服务』总开关 → 勾选下面 4 个事件"
          >
            <div className="mt-2 overflow-hidden rounded-md border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">事件代码</th>
                    <th className="px-3 py-1.5 text-left font-medium">名称</th>
                    <th className="px-3 py-1.5 text-left font-medium">用途</th>
                  </tr>
                </thead>
                <tbody>
                  {EVENTS.map((e) => (
                    <tr key={e.code} className="border-t">
                      <td className="px-3 py-1.5 font-mono">{e.code}</td>
                      <td className="px-3 py-1.5">{e.label}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{e.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              找不到事件？去「类目能力 → 类目管理」申请对应能力包再回来订阅。
            </p>
          </Step>
          <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
            💡 配好后：随便去有赞门店 POS 下一单付款，回到本页刷新，「最近一次推送」应该变成刚才的时间 = 通了。
          </div>
        </CardContent>
      </Card>

      {/* 最近日志 */}
      <MessageLogList
        logs={q.data?.logs ?? []}
        loading={q.isLoading}
      />
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
        {n}
      </div>
      <div className="flex-1 space-y-1">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function MessageLogList({
  logs,
  loading,
}: {
  logs: Array<{
    id: string;
    kdt_id: number | null;
    status: string;
    message: string | null;
    error: string | null;
    started_at: string;
  }>;
  loading: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                {open ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                最近 20 条推送日志
              </span>
              <Badge variant="outline">{logs.length}</Badge>
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            {loading ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                加载中…
              </div>
            ) : logs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/50" />
                <div className="text-sm text-muted-foreground">
                  暂无消息推送记录
                </div>
                <div className="text-xs text-muted-foreground/70">
                  按上方 3 步在有赞云配置后，这里就会实时出现推送记录。
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">时间</th>
                      <th className="px-3 py-1.5 text-left font-medium">kdt_id</th>
                      <th className="px-3 py-1.5 text-left font-medium">状态</th>
                      <th className="px-3 py-1.5 text-left font-medium">信息</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((l) => (
                      <tr key={l.id} className="border-t">
                        <td className="px-3 py-1.5 font-mono tabular-nums">
                          {new Date(l.started_at).toLocaleString("zh-CN")}
                        </td>
                        <td className="px-3 py-1.5 font-mono tabular-nums">
                          {l.kdt_id ?? "—"}
                        </td>
                        <td className="px-3 py-1.5">
                          <StatusBadge
                            tone={
                              l.status === "ok"
                                ? "success"
                                : l.status === "error"
                                  ? "danger"
                                  : "neutral"
                            }
                          >
                            {l.status}
                          </StatusBadge>
                        </td>
                        <td
                          className="max-w-[420px] truncate px-3 py-1.5 text-muted-foreground"
                          title={l.error ?? l.message ?? ""}
                        >
                          {l.error ?? l.message ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
