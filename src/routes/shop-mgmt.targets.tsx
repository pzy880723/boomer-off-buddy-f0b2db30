import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getMonthlyTargetPlan,
  getStoreDailySummary,
  listTargetAuditLogs,
  listTargetLocations,
  publishMonthlyTargetPlan,
  setDailyTargetOverride,
} from "@/lib/store-targets.functions";
import { shanghaiToday } from "@/lib/store-targets/sales-window";

export const Route = createFileRoute("/shop-mgmt/targets")({
  head: () => ({
    meta: [
      { title: "门店销售目标配置 | BOOMER ERP" },
      {
        name: "description",
        content: "按门店设置月度销售目标，自动拆分到每一天，支持周末权重、单日调整与发布留痕。",
      },
      { property: "og:title", content: "门店销售目标配置 | BOOMER ERP" },
      {
        property: "og:description",
        content: "月目标自动拆分为日目标，今日目标、今日实绩与差额一目了然。",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TargetsPage,
});

const yuan = (fen: number | null | undefined) =>
  fen == null ? "—" : `¥${(fen / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`;

type DayTargetRow = {
  target_date: string;
  target_amount_fen: number | string;
  source: string;
  is_locked: boolean;
};

type AuditRow = {
  id: string;
  action: string;
  period_month: string | null;
  target_date: string | null;
  reason: string | null;
  created_at: string;
};

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function TargetsPage() {
  const qc = useQueryClient();
  const today = shanghaiToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [locationId, setLocationId] = useState<string>("");
  const [monthlyYuan, setMonthlyYuan] = useState("");
  const [weights, setWeights] = useState<number[]>([1, 1, 1, 1, 1, 1.5, 1.5]);
  const [reason, setReason] = useState("");

  const locations = useQuery({
    queryKey: ["target-locations"],
    queryFn: () => listTargetLocations(),
  });

  const activeLocation = locationId || (locations.data?.[0]?.id ?? "");

  const plan = useQuery({
    queryKey: ["target-plan", activeLocation, month],
    queryFn: () => getMonthlyTargetPlan({ data: { location_id: activeLocation, month } }),
    enabled: !!activeLocation,
  });

  const summary = useQuery({
    queryKey: ["target-summary", activeLocation, today],
    queryFn: () => getStoreDailySummary({ data: { location_id: activeLocation, date: today } }),
    enabled: !!activeLocation,
  });

  const audit = useQuery({
    queryKey: ["target-audit", activeLocation],
    queryFn: () => listTargetAuditLogs({ data: { location_id: activeLocation, limit: 10 } }),
    enabled: !!activeLocation,
  });

  const publish = useMutation({
    mutationFn: () =>
      publishMonthlyTargetPlan({
        data: {
          location_id: activeLocation,
          month,
          monthly_target_fen: Math.round(Number(monthlyYuan || 0) * 100),
          weekday_weights: Object.fromEntries(weights.map((w, i) => [String(i + 1), w])),
          reason: reason || null,
        },
      }),
    onSuccess: (res) => {
      toast.success(`已发布 v${res.version}，写入 ${res.written_days} 天`);
      if (res.warnings.length > 0) toast.warning(res.warnings.join("；"));
      void qc.invalidateQueries({ queryKey: ["target-plan"] });
      void qc.invalidateQueries({ queryKey: ["target-audit"] });
      void qc.invalidateQueries({ queryKey: ["target-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const override = useMutation({
    mutationFn: (v: { date: string; yuan: string }) =>
      setDailyTargetOverride({
        data: {
          location_id: activeLocation,
          date: v.date,
          target_amount_fen: Math.round(Number(v.yuan || 0) * 100),
          lock: true,
          reason: reason || "单日手工调整",
        },
      }),
    onSuccess: () => {
      toast.success("单日目标已调整并锁定");
      void qc.invalidateQueries({ queryKey: ["target-plan"] });
      void qc.invalidateQueries({ queryKey: ["target-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const totalFen = useMemo(
    () =>
      (plan.data?.days ?? []).reduce(
        (s: number, d: DayTargetRow) => s + Number(d.target_amount_fen),
        0,
      ),
    [plan.data],
  );

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">门店销售目标</h1>
        <p className="text-muted-foreground text-sm">
          月目标只是拆解依据，店员端首页展示的是「今日目标 / 今日实绩 /
          差额」。已过去的日期与手工锁定日不会被重新拆分覆盖。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>门店</Label>
          <Select value={activeLocation} onValueChange={setLocationId}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="选择门店" />
            </SelectTrigger>
            <SelectContent>
              {(locations.data ?? []).map((l: { id: string; name: string }) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>月份</Label>
          <Input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="w-40"
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">今日进度（{today}，中国时间）</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-4">
          <Stat label="今日目标" value={yuan(summary.data?.target_fen ?? null)} />
          <Stat label="今日实绩" value={yuan(summary.data?.achieved_fen ?? null)} />
          <Stat label="差额" value={yuan(summary.data?.gap_fen ?? null)} />
          <div>
            <div className="text-muted-foreground text-xs">数据完整性</div>
            {summary.data ? (
              summary.data.completeness.complete ? (
                <Badge variant="secondary">完整</Badge>
              ) : (
                <div className="space-y-1">
                  <Badge variant="destructive">不完整</Badge>
                  <p className="text-muted-foreground text-xs">
                    {summary.data.completeness.reasons.join("、")}
                  </p>
                </div>
              )
            ) : (
              <span className="text-muted-foreground text-sm">—</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">发布本月目标</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>月目标（元）</Label>
              <Input
                value={monthlyYuan}
                onChange={(e) => setMonthlyYuan(e.target.value)}
                placeholder="例如 300000"
                className="w-40"
              />
            </div>
            <div className="space-y-1 grow">
              <Label>发布原因 / 备注</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="记录到审计日志"
              />
            </div>
            <Button
              disabled={!activeLocation || publish.isPending}
              onClick={() => publish.mutate()}
            >
              {publish.isPending ? "发布中…" : "发布并拆分到每日"}
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-7">
            {WEEKDAY_LABELS.map((label, i) => (
              <div key={label} className="space-y-1">
                <Label className="text-xs">{label}权重</Label>
                <Input
                  value={weights[i]}
                  onChange={(e) => {
                    const next = [...weights];
                    next[i] = Number(e.target.value) || 0;
                    setWeights(next);
                  }}
                />
              </div>
            ))}
          </div>
          {plan.data?.plan ? (
            <p className="text-muted-foreground text-sm">
              当前生效版本 v{plan.data.plan.version}，月目标{" "}
              {yuan(Number(plan.data.plan.target_amount_fen))}， 已拆分日目标合计 {yuan(totalFen)}。
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">本月尚未发布目标。</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">每日目标</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead>目标</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>调整</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(plan.data?.days ?? []).map((d: DayTargetRow) => (
                <DayRow
                  key={d.target_date}
                  date={d.target_date}
                  fen={Number(d.target_amount_fen)}
                  source={d.source}
                  locked={d.is_locked}
                  expired={d.target_date < today}
                  onSave={(v) => override.mutate({ date: d.target_date, yuan: v })}
                />
              ))}
              {(plan.data?.days ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground text-center">
                    还没有日目标，先发布本月目标。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近变更记录</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(audit.data ?? []).map((a: AuditRow) => (
            <div key={a.id} className="text-sm">
              <span className="text-muted-foreground">
                {new Date(a.created_at).toLocaleString("zh-CN")}
              </span>{" "}
              · {a.action} · {a.target_date ?? a.period_month} {a.reason ? `· ${a.reason}` : ""}
            </div>
          ))}
          {(audit.data ?? []).length === 0 && (
            <p className="text-muted-foreground text-sm">暂无记录。</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function DayRow({
  date,
  fen,
  source,
  locked,
  expired,
  onSave,
}: {
  date: string;
  fen: number;
  source: string;
  locked: boolean;
  expired: boolean;
  onSave: (yuan: string) => void;
}) {
  const [value, setValue] = useState((fen / 100).toFixed(2));
  return (
    <TableRow>
      <TableCell>{date}</TableCell>
      <TableCell>{yuan(fen)}</TableCell>
      <TableCell>
        {source === "manual_override" ? "手工调整" : source === "closed_day" ? "闭店" : "自动拆分"}
        {locked ? " · 已锁定" : ""}
        {expired ? " · 已过期" : ""}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} className="w-28" />
          <Button size="sm" variant="outline" onClick={() => onSave(value)}>
            保存
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
