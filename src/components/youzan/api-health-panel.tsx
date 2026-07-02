import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  MinusCircle,
  ShieldAlert,
  Ban,
  Wifi,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { runYouzanApiHealthCheck } from "@/lib/youzan-health.functions";
import { detectYouzanOutboundIp } from "@/lib/youzan-outbound.functions";

import {
  YZ_FEATURE_LABELS,
  YZ_STATUS_LABELS,
  type YzApiFeature,
  type YzProbeStatus,
} from "@/lib/youzan-api-registry";

const STATUS_ICON: Record<YzProbeStatus, React.ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  skip_write: MinusCircle,
  skip_scope: MinusCircle,
  token_fail: ShieldAlert,
  gw_4001: ShieldAlert,
  gw_4005: Ban,
  gw_4007: Wifi,
  gw_other: XCircle,
  network_error: XCircle,
};

const STATUS_CLASS: Record<YzProbeStatus, string> = {
  ok: "text-emerald-600 bg-emerald-50 border-emerald-200",
  skip_write: "text-muted-foreground bg-muted/40 border-border",
  skip_scope: "text-muted-foreground bg-muted/40 border-border",
  token_fail: "text-orange-600 bg-orange-50 border-orange-200",
  gw_4001: "text-orange-600 bg-orange-50 border-orange-200",
  gw_4005: "text-red-600 bg-red-50 border-red-200",
  gw_4007: "text-amber-600 bg-amber-50 border-amber-200",
  gw_other: "text-red-600 bg-red-50 border-red-200",
  network_error: "text-red-600 bg-red-50 border-red-200",
};

export function ApiHealthPanel() {
  const runFn = useServerFn(runYouzanApiHealthCheck);
  const detectFn = useServerFn(detectYouzanOutboundIp);

  const q = useQuery({
    queryKey: ["youzan-api-health"],
    queryFn: () => runFn(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const m = useMutation({
    mutationFn: () => runFn(),
    onSuccess: () => {
      toast.success("体检完成");
      q.refetch();
    },
    onError: (e: Error) => toast.error(`体检失败：${e.message}`),
  });

  const detect = useMutation({
    mutationFn: () => detectFn(),
    onSuccess: (r) => {
      toast.success(r.message ?? `检测到出口 IP：${r.ip}`, {
        description: `请把 ${r.ip} 加入有赞后台 IP 白名单`,
        duration: 8000,
      });
      q.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const running = q.isLoading || m.isPending;


  if (running && !q.data) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在对每家门店逐个探测有赞 API…
        </CardContent>
      </Card>
    );
  }

  const report = q.data;
  if (!report) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Button onClick={() => m.mutate()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            开始体检
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 统计
  const totalCells = report.results.length;
  const okCells = report.results.filter((r) => r.status === "ok").length;
  const failCells = report.results.filter(
    (r) => r.status !== "ok" && r.status !== "skip_scope" && r.status !== "skip_write",
  ).length;
  const blockedByIp = report.results.some((r) => r.status === "gw_4007");
  const blockedByCap = report.results.some((r) => r.status === "gw_4005");

  // 按 feature 分组
  const byFeature = new Map<YzApiFeature, typeof report.registry>();
  for (const spec of report.registry) {
    const arr = byFeature.get(spec.feature) ?? [];
    arr.push(spec);
    byFeature.set(spec.feature, arr);
  }
  const resultKey = (apiKey: string, shopId: string) => `${apiKey}::${shopId}`;
  const resultMap = new Map(report.results.map((r) => [resultKey(r.api_key, r.shop_id), r]));

  const lastPushByShop = new Map(
    (report.last_stock_push.global ?? []).map((r) => [r.shop_id, r]),
  );

  return (
    <div className="space-y-4">
      {/* 顶部汇总 */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {report.shops.length} 家门店 × {report.registry.length} 个接口
              </Badge>
              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                通过 {okCells}
              </Badge>
              {failCells > 0 && (
                <Badge className="bg-red-100 text-red-700 hover:bg-red-100">异常 {failCells}</Badge>
              )}
              <Badge variant="outline">
                {report.outbound.mode === "fixed_proxy"
                  ? `固定出口 ${report.outbound.outbound_ip ?? ""}`
                  : "动态出口"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(report.ran_at).toLocaleString("zh-CN")}
              </span>
            </div>
            {(blockedByIp || blockedByCap) && (
              <p className="text-xs text-muted-foreground">
                {blockedByIp && "· 存在 IP 白名单未加白，请把固定出口 IP 加到有赞白名单 "}
                {blockedByCap && "· 存在能力未开通，请到有赞云后台 应用能力 勾选下方红色标注的能力"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {report.outbound.mode === "fixed_proxy" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => detect.mutate()}
                disabled={detect.isPending}
                title="通过有赞返回中的白名单错误自动解析出口 IP，并保存到系统设置"
              >
                {detect.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wifi className="mr-1.5 h-3.5 w-3.5" />
                )}
                自动检测出口 IP
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => m.mutate()} disabled={m.isPending}>
              {m.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              重新体检
            </Button>
          </div>

        </CardContent>
      </Card>

      {/* 门店 × 接口 矩阵 */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 text-xs">
              <tr>
                <th className="min-w-[260px] px-3 py-2 text-left font-medium">接口 / 能力</th>
                {report.shops.map((s) => (
                  <th
                    key={s.id}
                    className="min-w-[120px] px-2 py-2 text-center font-medium"
                    title={`kdt_id ${s.kdt_id}`}
                  >
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="max-w-[110px] truncate">{s.shop_name}</span>
                      <span className="text-[10px] font-normal text-muted-foreground">
                        {s.role === "hq" ? "总部" : "分店"}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from(byFeature.entries()).map(([feature, specs]) => (
                <FeatureRows
                  key={feature}
                  feature={feature}
                  specs={specs}
                  shops={report.shops}
                  resultMap={resultMap}
                  lastPushByShop={lastPushByShop}
                />
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        提示：写入类接口（库存推送、发货等）体检不做实调，避免影响真实数据；用最近一次成功推送时间做为健康信号。
      </p>
    </div>
  );
}

function FeatureRows({
  feature,
  specs,
  shops,
  resultMap,
  lastPushByShop,
}: {
  feature: YzApiFeature;
  specs: ReturnType<typeof groupedSpecsType>;
  shops: Array<{ id: string; shop_name: string; role: string; kdt_id: number }>;
  resultMap: Map<string, ReturnType<typeof anyResult>>;
  lastPushByShop: Map<string, { last_pushed_at: string | null; error: string | null }>;
}) {
  return (
    <>
      <tr className="bg-muted/30">
        <td colSpan={shops.length + 1} className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
          {YZ_FEATURE_LABELS[feature]}
        </td>
      </tr>
      {specs.map((spec) => (
        <tr key={spec.key} className="border-t align-top">
          <td className="px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <code className="font-mono text-xs">{spec.method}</code>
                <span className="text-[10px] text-muted-foreground">{spec.version}</span>
                {!spec.in_use && (
                  <Badge variant="outline" className="text-[10px]">
                    规划中
                  </Badge>
                )}
                {spec.required && (
                  <Badge variant="outline" className="border-primary/30 text-[10px] text-primary">
                    必需
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{spec.description}</p>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>能力名：{spec.capability_name}</span>
                <a
                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  href={spec.doc_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  文档
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </td>
          {shops.map((s) => {
            const r = resultMap.get(`${spec.key}::${s.id}`);
            if (!r) {
              return (
                <td key={s.id} className="px-2 py-2 text-center text-xs text-muted-foreground">
                  —
                </td>
              );
            }
            const Icon = STATUS_ICON[r.status];
            const cls = STATUS_CLASS[r.status];
            const info = YZ_STATUS_LABELS[r.status];
            const extra =
              r.status === "skip_write"
                ? formatLastPush(lastPushByShop.get(s.id))
                : r.latency_ms != null
                  ? `${r.latency_ms}ms`
                  : null;
            return (
              <td key={s.id} className="px-2 py-2 text-center">
                <div
                  className={`inline-flex flex-col items-center gap-0.5 rounded border px-2 py-1 ${cls}`}
                  title={
                    (info.hint ?? "") + (r.message ? `\n\n${r.message}` : "") + (r.trace_id ? `\ntrace=${r.trace_id}` : "")
                  }
                >
                  <div className="flex items-center gap-1">
                    <Icon className="h-3 w-3" />
                    <span className="text-[11px] font-medium">{info.label}</span>
                  </div>
                  {extra && <span className="text-[10px] opacity-80">{extra}</span>}
                </div>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

function formatLastPush(row?: { last_pushed_at: string | null; error: string | null }) {
  if (!row || !row.last_pushed_at) return "从未推送";
  const diff = Date.now() - new Date(row.last_pushed_at).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  return `${Math.floor(h / 24)}d 前`;
}

// helpers just for typing
function groupedSpecsType() {
  return [] as import("@/lib/youzan-api-registry").YzApiSpec[];
}
function anyResult() {
  return null as unknown as import("@/lib/youzan-health.functions").YzHealthResult;
}
