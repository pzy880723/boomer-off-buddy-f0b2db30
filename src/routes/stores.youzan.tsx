import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Plus,
  Trash2,
  RefreshCw,
  Activity,
  Store as StoreIcon,
  Building2,
  TrendingUp,
  ShoppingBag,
  Package,
  Boxes,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import {
  listYouzanShops,
  listYouzanSyncLogs,
  pingYouzanShop,
  removeYouzanShop,
  listAuthorizedShopsFromHQ,
  batchImportShops,
} from "@/lib/youzan.functions";
import {
  getYouzanSummary,
  getShopSalesBreakdown,
} from "@/lib/youzan-stats.functions";

export const Route = createFileRoute("/stores/youzan")({
  head: () => ({
    meta: [
      { title: "有赞门店 · 总部汇总" },
      { name: "description", content: "总部 + 分店统一管理与业绩汇总" },
    ],
  }),
  component: YouzanPage,
});

const cny = (n: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  }).format(n);

const num = (n: number) => new Intl.NumberFormat("zh-CN").format(n);

function relativeTime(iso: string | null) {
  if (!iso) return "尚未同步";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function YouzanPage() {
  const qc = useQueryClient();
  const fetchShops = useServerFn(listYouzanShops);
  const fetchLogs = useServerFn(listYouzanSyncLogs);
  const fetchSummary = useServerFn(getYouzanSummary);
  const fetchBreakdown = useServerFn(getShopSalesBreakdown);
  const pingFn = useServerFn(pingYouzanShop);
  const removeFn = useServerFn(removeYouzanShop);

  const shopsQ = useQuery({
    queryKey: ["youzan-shops"],
    queryFn: () => fetchShops(),
  });
  const summaryQ = useQuery({
    queryKey: ["youzan-summary"],
    queryFn: () => fetchSummary(),
    refetchInterval: 60_000,
  });
  const breakdownQ = useQuery({
    queryKey: ["youzan-breakdown"],
    queryFn: () => fetchBreakdown(),
    refetchInterval: 60_000,
  });
  const logsQ = useQuery({
    queryKey: ["youzan-sync-logs"],
    queryFn: () => fetchLogs({ data: { limit: 30 } }),
    refetchInterval: 10_000,
  });

  const pingM = useMutation({
    mutationFn: (id: string) => pingFn({ data: { shop_id: id } }),
    onSuccess: (r) => {
      if (r.ok) toast.success("门店连接正常");
      else toast.error(`连接失败：${r.message}`);
      qc.invalidateQueries({ queryKey: ["youzan-shops"] });
    },
  });

  const removeM = useMutation({
    mutationFn: (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已移除门店");
      qc.invalidateQueries({ queryKey: ["youzan-shops"] });
    },
  });

  const shops = shopsQ.data?.shops ?? [];
  const summary = summaryQ.data;
  const breakdown = breakdownQ.data?.breakdown ?? {};
  const logs = logsQ.data?.logs ?? [];
  const hq = shops.find((s) => s.role === "hq");
  const branches = shops.filter((s) => s.role === "branch");

  return (
    <div>
      <PageHeader
        title="有赞门店"
        description={`${shops.length} 家门店 · ${summary?.shopOnline ?? 0} 家在线 · 最近同步 ${relativeTime(summary?.lastSyncAt ?? null)}`}
        backTo="/dashboard"
        backLabel="返回仪表盘"
        actions={
          <ImportShopsDialog
            hqExists={!!hq}
            hqKdtId={hq?.kdt_id ?? null}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ["youzan-shops"] });
              qc.invalidateQueries({ queryKey: ["youzan-summary"] });
            }}
          />
        }
      />

      {/* 业务汇总 4 卡 */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={TrendingUp}
          label="本月营业额"
          value={summary ? cny(summary.revenueMonthCny) : "—"}
          hint={summary?.hasData ? "全部门店相加" : "等待首次同步"}
          tone="primary"
        />
        <MetricCard
          icon={ShoppingBag}
          label="本月订单"
          value={summary ? num(summary.orderCountMonth) : "—"}
          hint={summary?.hasData ? "已完成 + 进行中" : "等待首次同步"}
        />
        <MetricCard
          icon={Package}
          label="在售商品"
          value={summary ? num(summary.listedItemCount) : "—"}
          hint={summary?.hasData ? "总部商品库" : "等待首次同步"}
        />
        <MetricCard
          icon={Boxes}
          label="总库存"
          value={summary ? num(summary.stockTotal) : "—"}
          hint={summary?.hasData ? "全部门店相加" : "等待首次同步"}
        />
      </div>

      {/* 门店卡片 */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">我的门店</h2>
        {shops.length > 0 && (
          <span className="text-xs text-muted-foreground">
            总部 {hq ? 1 : 0} · 分店 {branches.length}
          </span>
        )}
      </div>

      {shops.length === 0 ? (
        <EmptyShops />
      ) : (
        <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {hq && (
            <ShopCard
              shop={hq}
              breakdown={breakdown[hq.id]}
              onPing={() => pingM.mutate(hq.id)}
              onRemove={() => {
                if (confirm(`移除总部「${hq.shop_name}」？分店将无法同步。`)) {
                  removeM.mutate(hq.id);
                }
              }}
              pinging={pingM.isPending && pingM.variables === hq.id}
            />
          )}
          {branches.map((s) => (
            <ShopCard
              key={s.id}
              shop={s}
              breakdown={breakdown[s.id]}
              onPing={() => pingM.mutate(s.id)}
              onRemove={() => {
                if (confirm(`移除门店「${s.shop_name}」？`)) {
                  removeM.mutate(s.id);
                }
              }}
              pinging={pingM.isPending && pingM.variables === s.id}
            />
          ))}
        </div>
      )}

      {/* 高级 / 同步明细 折叠 */}
      <Collapsible className="mt-8">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <Activity className="mr-1.5 h-3.5 w-3.5" />
            高级 · 同步明细
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3">
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
                      <span className="font-mono text-xs tabular-nums">
                        {r.kdt_id ?? "—"}
                      </span>
                    ),
                  },
                  {
                    header: "动作",
                    cell: (r) => <span className="text-xs">{r.action}</span>,
                  },
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
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ============================================================
// 汇总卡
// ============================================================
function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: "primary";
}) {
  return (
    <Card className={tone === "primary" ? "border-primary/30 bg-primary/[0.03]" : ""}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon
            className={
              tone === "primary"
                ? "h-4 w-4 text-primary"
                : "h-4 w-4 text-muted-foreground"
            }
          />
        </div>
        <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

// ============================================================
// 门店卡
// ============================================================
type Shop = {
  id: string;
  kdt_id: number;
  shop_name: string;
  role: string;
  last_ping_ok: boolean | null;
  last_ping_at: string | null;
  last_ping_msg: string | null;
  expires_at: string | null;
  token_expires_at: string | null;
};

function ShopCard({
  shop,
  breakdown,
  onPing,
  onRemove,
  pinging,
}: {
  shop: Shop;
  breakdown?: { revenue: number; count: number };
  onPing: () => void;
  onRemove: () => void;
  pinging: boolean;
}) {
  const isHq = shop.role === "hq";
  const Icon = isHq ? Building2 : StoreIcon;

  // 授权有效期警告
  const daysLeft = shop.expires_at
    ? Math.floor((new Date(shop.expires_at).getTime() - Date.now()) / 86_400_000)
    : null;
  const expiringSoon = daysLeft != null && daysLeft <= 14 && daysLeft >= 0;
  const expired = daysLeft != null && daysLeft < 0;

  return (
    <Card className="group transition hover:border-primary/40 hover:shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <div
              className={
                isHq
                  ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
                  : "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
              }
            >
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate font-medium">{shop.shop_name}</p>
                {isHq && (
                  <Badge className="h-4 bg-primary/10 px-1.5 text-[10px] font-medium text-primary hover:bg-primary/10">
                    总部
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {shop.last_ping_at == null ? (
                  "尚未连接，请点击「测试连接」"
                ) : shop.last_ping_ok ? (
                  <span className="inline-flex items-center gap-1 text-success">
                    <CheckCircle2 className="h-3 w-3" /> 已连接 · {relativeTime(shop.last_ping_at)}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-destructive">
                    <AlertTriangle className="h-3 w-3" /> 连接异常
                  </span>
                )}
              </p>
            </div>
          </div>

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 opacity-0 transition group-hover:opacity-100"
            onClick={onRemove}
            title="移除门店"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>

        {/* 本月业绩 */}
        {!isHq && breakdown && (
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-muted/40 p-2.5">
            <div>
              <p className="text-[10px] text-muted-foreground">本月营业额</p>
              <p className="text-sm font-semibold tabular-nums">
                {cny(breakdown.revenue)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">本月订单</p>
              <p className="text-sm font-semibold tabular-nums">
                {num(breakdown.count)} 单
              </p>
            </div>
          </div>
        )}
        {!isHq && !breakdown && (
          <div className="mt-3 rounded-md bg-muted/40 p-2.5 text-center text-[11px] text-muted-foreground">
            等待首次同步…
          </div>
        )}

        {/* 授权过期提醒 */}
        {(expiringSoon || expired) && (
          <div
            className={
              "mt-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] " +
              (expired
                ? "bg-destructive/10 text-destructive"
                : "bg-warning/10 text-warning")
            }
          >
            <AlertTriangle className="h-3 w-3" />
            {expired
              ? `授权已过期 ${Math.abs(daysLeft!)} 天`
              : `授权还剩 ${daysLeft} 天，请尽快续期`}
          </div>
        )}

        {/* 操作 */}
        <div className="mt-3 flex items-center justify-between">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={pinging}
            onClick={onPing}
          >
            {pinging ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" />
            )}
            测试连接
          </Button>
          {!isHq && (
            <span className="inline-flex items-center text-[11px] text-muted-foreground/60">
              详情 <ChevronRight className="h-3 w-3" />
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// 空状态
// ============================================================
function EmptyShops() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <StoreIcon className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">还没有连接任何门店</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          点击右上角「添加分店授权」即可一键从有赞总部拉取所有已授权的分店列表。
        </p>
      </CardContent>
    </Card>
  );
}

// ============================================================
// 添加分店：一键拉取 + 复选框批量授权
// ============================================================
function ImportShopsDialog({
  hqExists,
  hqKdtId,
  onDone,
}: {
  hqExists: boolean;
  hqKdtId: number | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shops, setShops] = useState<
    Array<{
      kdt_id: number;
      shop_name: string;
      shop_type?: string | null;
      address?: string | null;
      already_added: boolean;
    }>
  >([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);

  const fetchChain = useServerFn(listAuthorizedShopsFromHQ);
  const importFn = useServerFn(batchImportShops);

  const handleOpen = async (next: boolean) => {
    setOpen(next);
    if (next && hqExists) {
      setLoading(true);
      setError(null);
      try {
        const r = await fetchChain();
        setShops(r.shops);
        setError(r.error);
        setSelected(
          new Set(r.shops.filter((s) => !s.already_added).map((s) => s.kdt_id)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  const handleImport = async () => {
    const picked = shops.filter((s) => selected.has(s.kdt_id) && !s.already_added);
    if (picked.length === 0) {
      toast.error("请选择至少一家门店");
      return;
    }
    setImporting(true);
    try {
      const r = await importFn({
        data: {
          shops: picked.map((s) => ({
            kdt_id: s.kdt_id,
            shop_name: s.shop_name,
            parent_kdt_id: hqKdtId,
          })),
        },
      });
      if (r.added > 0) toast.success(`成功添加 ${r.added} 家门店`);
      if (r.failed > 0) {
        toast.error(
          `${r.failed} 家失败：${r.errors.map((e) => `kdt_id=${e.kdt_id}`).join(", ")}`,
        );
      }
      onDone();
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand hover:opacity-90">
          <Plus className="mr-1 h-3.5 w-3.5" />
          添加分店授权
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            一键导入分店
          </DialogTitle>
          <DialogDescription>
            从总部连锁账号自动拉取所有可用门店，勾选要接入的分店即可。
          </DialogDescription>
        </DialogHeader>

        {!hqExists && (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            尚未配置总部门店。请先在数据库添加 role=hq 的门店记录后再试。
          </div>
        )}

        {hqExists && loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在从有赞拉取分店列表…
          </div>
        )}

        {hqExists && !loading && error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <p className="font-medium text-destructive">无法自动拉取</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
            <div className="mt-2 rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">
              请到{" "}
              <a
                href="https://www.youzanyun.com/devhome"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                有赞云开发者中心
              </a>{" "}
              的「自用型应用 → 授权店铺」勾选要接入的分店，回来再点一次按钮即可。
            </div>
          </div>
        )}

        {hqExists && !loading && !error && shops.length > 0 && (
          <div className="max-h-[360px] space-y-1.5 overflow-auto">
            {shops.map((s) => (
              <label
                key={s.kdt_id}
                className={
                  "flex items-start gap-3 rounded-md border p-2.5 transition " +
                  (s.already_added
                    ? "border-muted bg-muted/30 opacity-60"
                    : selected.has(s.kdt_id)
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border hover:bg-muted/40 cursor-pointer")
                }
              >
                <Checkbox
                  checked={selected.has(s.kdt_id) || s.already_added}
                  disabled={s.already_added}
                  onCheckedChange={(v) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(s.kdt_id);
                      else next.delete(s.kdt_id);
                      return next;
                    });
                  }}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{s.shop_name}</p>
                    {s.already_added && (
                      <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                        已添加
                      </Badge>
                    )}
                    {s.shop_type && (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                        {s.shop_type}
                      </Badge>
                    )}
                  </div>
                  {s.address && (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {s.address}
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}

        {hqExists && !loading && !error && shops.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
            未发现已授权的分店。请到有赞云后台授权后重试。
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={importing}>
            取消
          </Button>
          {hqExists && !loading && !error && shops.length > 0 && (
            <Button
              onClick={handleImport}
              disabled={
                importing ||
                shops.filter((s) => selected.has(s.kdt_id) && !s.already_added).length === 0
              }
            >
              {importing && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              批量授权并添加（
              {shops.filter((s) => selected.has(s.kdt_id) && !s.already_added).length}
              ）
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
