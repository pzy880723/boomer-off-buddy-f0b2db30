import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Building2, Users, Bell, Plug, Webhook, Key, History, MapPin, RefreshCw, Loader2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { AddressBookPanel } from "@/components/settings/address-book-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import {
  getYouzanDefaultCategoryId,
  setYouzanDefaultCategoryId,
} from "@/lib/app-settings.functions";
import { fetchYouzanGroupsLive, type YouzanGroupNode } from "@/lib/categories.functions";
import { diagnoseYouzanListing } from "@/lib/youzan.functions";


const SETTINGS_TABS = [
  "profile",
  "members",
  "addresses",
  "notify",
  "integration",
  "webhook",
  "api",
  "audit",
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

const SearchSchema = z.object({
  tab: z.string().optional(),
});

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "系统设置 · BOOMER OFF" }, { name: "description", content: "权限角色、数据字典与操作日志" }] }),
  validateSearch: (s) => SearchSchema.parse(s),
  component: SettingsPage,
});


type NavItem = { value: SettingsTab; label: string; icon: typeof Building2 };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: "账户",
    items: [
      { value: "profile", label: "基本信息", icon: Building2 },
      { value: "members", label: "成员权限", icon: Users },
      { value: "addresses", label: "地址库", icon: MapPin },
    ],
  },
  {
    label: "通知与集成",
    items: [
      { value: "notify", label: "通知", icon: Bell },
      { value: "integration", label: "集成", icon: Plug },
      { value: "webhook", label: "Webhook", icon: Webhook },
      { value: "api", label: "API 密钥", icon: Key },
    ],
  },
  {
    label: "安全",
    items: [{ value: "audit", label: "审计日志", icon: History }],
  },
];

function SettingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const activeTab: SettingsTab = (SETTINGS_TABS as readonly string[]).includes(search.tab ?? "")
    ? (search.tab as SettingsTab)
    : "profile";
  const setTab = (v: string) => {
    navigate({ search: { tab: v === "profile" ? undefined : v }, replace: true });
  };
  return (
    <div>
      <PageHeader title="系统设置" description="账户、通知、集成与安全策略管理" />
      <Tabs value={activeTab} onValueChange={setTab} className="gap-4">

        {/* 移动端：顶部横向滚动 chip */}
        <TabsList className="md:hidden -mx-1 flex w-[calc(100%+0.5rem)] gap-1 overflow-x-auto px-1 no-scrollbar">
          {NAV_GROUPS.flatMap((g) => g.items).map((it) => (
            <TabsTrigger key={it.value} value={it.value} className="shrink-0 gap-1.5">
              <it.icon className="h-3.5 w-3.5" />
              {it.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="md:grid md:grid-cols-[13rem_1fr] md:gap-6">
          {/* 桌面端：左侧分组导航 */}
          <aside className="hidden md:block">
            <nav className="sticky top-4 space-y-5 pr-2">
              {NAV_GROUPS.map((g) => (
                <div key={g.label}>
                  <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {g.label}
                  </div>
                  <TabsList className="flex h-auto w-full flex-col gap-0.5 bg-transparent p-0">
                    {g.items.map((it) => (
                      <TabsTrigger
                        key={it.value}
                        value={it.value}
                        className="group w-full justify-start gap-2 rounded-md border-l-2 border-transparent px-2.5 py-1.5 text-sm font-normal text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none hover:bg-muted/60"
                      >
                        <it.icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{it.label}</span>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              ))}
            </nav>
          </aside>

          <div className="min-w-0">


        <TabsContent value="profile">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">品牌基本信息</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>品牌名称</Label>
                <Input defaultValue="BOOMER OFF · vintage group" />
              </div>
              <div className="space-y-2">
                <Label>统一社会信用代码</Label>
                <Input defaultValue="91310000XXXXXXXXXX" />
              </div>
              <div className="space-y-2">
                <Label>注册地址</Label>
                <Input defaultValue="上海市徐汇区安福路 322 号" />
              </div>
              <div className="space-y-2">
                <Label>客服热线</Label>
                <Input defaultValue="400-888-XXXX" />
              </div>
              <div className="md:col-span-2 flex justify-end">
                <Button className="bg-gradient-brand hover:opacity-90">保存修改</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="members">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">成员与权限</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {[
                  { name: "管理员", role: "超级管理员", count: 1, color: "brand" },
                  { name: "采购组", role: "采购员", count: 4, color: "info" },
                  { name: "运营组", role: "运营专员", count: 6, color: "info" },
                  { name: "门店店长", role: "门店权限", count: 12, color: "muted" },
                ].map((g) => (
                  <div key={g.name} className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <p className="font-medium">{g.name}</p>
                      <p className="text-xs text-muted-foreground">{g.role}</p>
                    </div>
                    <Badge variant="secondary">{g.count} 人</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="addresses">
          <AddressBookPanel />
        </TabsContent>





        <TabsContent value="notify">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">通知偏好</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                { label: "库存预警通知", desc: "门店库存低于阈值时推送" },
                { label: "包裹清关完成通知", desc: "海关放行后立即推送" },
                { label: "批次回本通知", desc: "采购批次达到 100% 回本时推送" },
                { label: "异常订单通知", desc: "退款、纠纷等异常订单实时推送" },
              ].map((n) => (
                <div key={n.label} className="flex items-center justify-between border-b pb-3 last:border-0">
                  <div>
                    <p className="text-sm font-medium">{n.label}</p>
                    <p className="text-xs text-muted-foreground">{n.desc}</p>
                  </div>
                  <Switch defaultChecked />
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="integration" className="space-y-4">
          <YouzanDefaultGroupCard />
          <YouzanDiagnosticsCard />
          <div className="grid gap-3 md:grid-cols-2">
            {[
              { name: "有赞连锁", status: "已连接", tone: "success" },
              { name: "企业微信", status: "已连接", tone: "success" },
              { name: "钉钉机器人", status: "待配置", tone: "warning" },
              { name: "金蝶云财务", status: "待配置", tone: "warning" },
            ].map((i) => (
              <Card key={i.name}>
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-medium">{i.name}</p>
                    <p className="text-xs text-muted-foreground">第三方集成</p>
                  </div>
                  <Badge className={i.tone === "success" ? "bg-success/10 text-success" : "bg-warning/15 text-warning-foreground"}>
                    {i.status}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>


        <TabsContent value="webhook">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Webhook 配置</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>回调 URL</Label>
                <Input placeholder="https://your-domain.com/webhook" />
              </div>
              <div className="space-y-2">
                <Label>签名密钥</Label>
                <Input type="password" defaultValue="••••••••••••••••" />
              </div>
              <div className="flex justify-end">
                <Button className="bg-gradient-brand hover:opacity-90">保存</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="api">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">API 密钥管理</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border p-4 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Production Key</span>
                  <Badge variant="outline">活跃</Badge>
                </div>
                <p className="mt-2 break-all">bo_live_••••••••••••••••••••a3f9</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline">复制</Button>
                  <Button size="sm" variant="outline">轮转</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">系统操作日志</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {[
                  { user: "管理员", action: "更新通知偏好", time: "2 分钟前" },
                  { user: "采购员·张明", action: "新建大宗包裹 JP-B-1024", time: "1 小时前" },
                  { user: "运营·李华", action: "导出商品档案 (348 条)", time: "3 小时前" },
                  { user: "店长·周晓", action: "提交调拨申请 TR-0421", time: "今天 09:24" },
                ].map((l, i) => (
                  <li key={i} className="flex items-center justify-between border-b pb-2 last:border-0">
                    <div>
                      <span className="font-medium">{l.user}</span>
                      <span className="ml-2 text-muted-foreground">{l.action}</span>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">{l.time}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>
          </div>
        </div>

      </Tabs>
    </div>
  );
}

function YouzanDiagnosticsCard() {
  const diagnoseFn = useServerFn(diagnoseYouzanListing);
  const [result, setResult] = useState<Awaited<ReturnType<typeof diagnoseFn>> | null>(null);
  const allPassed = result ? result.steps.every((step) => step.status === "ok") : false;
  const mut = useMutation({
    mutationFn: () => diagnoseFn(),
    onSuccess: (data) => {
      setResult(data);
      if (data.steps.every((step) => step.status === "ok")) toast.success("有赞同步体检通过");
      else toast.warning("有赞同步体检发现需要处理的地方");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "体检失败"),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>有赞同步体检</span>
          {result ? (
            <Badge variant="outline" className={allPassed ? "text-emerald-600" : "text-amber-600"}>
              {allPassed ? "正常" : "需要处理"}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          点一下，系统会自己检查有赞连接、默认分组和推商品接口，不需要你看代码。
        </p>
        <Button size="sm" variant="outline" onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
          )}
          开始体检
        </Button>

        {result && (
          <div className="space-y-2 rounded-md border p-3">
            {result.steps.map((step) => {
              const Icon = step.status === "ok" ? CheckCircle2 : step.status === "warn" ? AlertTriangle : XCircle;
              const tone = step.status === "ok" ? "text-emerald-600" : step.status === "warn" ? "text-amber-600" : "text-destructive";
              return (
                <div key={step.label} className="flex gap-2 text-xs">
                  <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{step.label}</div>
                    <div className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
                      {step.message}
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="border-t pt-2 text-[11px] text-muted-foreground">
              网络出口：{result.outbound.message}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function YouzanDefaultGroupCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getYouzanDefaultCategoryId);
  const setFn = useServerFn(setYouzanDefaultCategoryId);
  const fetchFn = useServerFn(fetchYouzanGroupsLive);

  const curQ = useQuery({ queryKey: ["yz-default-cat"], queryFn: () => getFn() });
  const yzQ = useQuery({
    queryKey: ["yz-groups-live"],
    queryFn: () => fetchFn(),
    staleTime: 5 * 60 * 1000,
  });

  const [selected, setSelected] = useState<number | null>(null);
  const [manualId, setManualId] = useState("");
  useEffect(() => {
    if (curQ.data?.id != null) {
      setSelected(curQ.data.id);
      setManualId(String(curQ.data.id));
    }
  }, [curQ.data?.id]);

  const rows: YouzanGroupNode[] = yzQ.data?.rows ?? [];
  const options = useMemo(() => {
    const byParent = new Map<number | null, YouzanGroupNode[]>();
    for (const y of rows) {
      const pid = y.parent_id ?? null;
      const arr = byParent.get(pid) ?? [];
      arr.push(y);
      byParent.set(pid, arr);
    }
    const flat: { id: number; label: string }[] = [];
    const walk = (pid: number | null, depth: number) => {
      const list = (byParent.get(pid) ?? []).sort(
        (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name),
      );
      for (const y of list) {
        flat.push({ id: y.id, label: `${"— ".repeat(depth)}${y.name}` });
        walk(y.id, depth + 1);
      }
    };
    walk(null, 0);
    return flat;
  }, [rows]);

  const saveMut = useMutation({
    mutationFn: (id: number | null) => setFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已保存默认分组");
      qc.invalidateQueries({ queryKey: ["yz-default-cat"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "保存失败"),
  });

  const currentName = curQ.data?.id
    ? (rows.find((r) => r.id === curQ.data!.id)?.name ?? `#${curQ.data!.id}`)
    : null;
  const manualNumericId = Number(manualId.trim());
  const saveId = selected ?? (Number.isInteger(manualNumericId) && manualNumericId > 0 ? manualNumericId : null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span>有赞同步 · 默认商品分组</span>
          {currentName ? (
            <Badge variant="outline" className="text-emerald-600">
              当前：{currentName}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-600">
              未配置
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          有赞 API 建 SPU 时必须传商品分组，这里选一个作为全局默认；ERP
          自己的商品分类和有赞分组互不绑定。
        </p>

        {yzQ.data?.blocking && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <div className="mb-1 font-medium text-destructive">拉取分组失败</div>
            {yzQ.data.blocking.kind === "ip_whitelist" && (
              <div>
                有赞拒绝了当前出口 IP，需要配置固定出口代理并把该 IP 加入有赞白名单。
              </div>
            )}
            {yzQ.data.blocking.kind === "no_api" && (
              <div>当前授权无接口：{yzQ.data.blocking.apis.join(", ")}</div>
            )}
            {yzQ.data.blocking.kind === "other" && (
              <pre className="whitespace-pre-wrap break-all text-muted-foreground">
                {yzQ.data.blocking.message}
              </pre>
            )}
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-[1fr_11rem_auto_auto] md:items-end">
          <div className="space-y-1.5">
            <Label>默认分组</Label>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={selected ?? ""}
              onChange={(e) =>
                setSelected(e.target.value ? Number(e.target.value) : null)
              }
              disabled={yzQ.isLoading || options.length === 0}
            >
              <option value="">
                {yzQ.isLoading ? "拉取中…" : options.length === 0 ? "无可用分组" : "— 选择分组 —"}
              </option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} #{o.id}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>手动填 ID</Label>
            <Input
              className="h-9 text-sm"
              inputMode="numeric"
              placeholder="例如 123456"
              value={manualId}
              onChange={(e) => {
                const next = e.target.value.replace(/[^0-9]/g, "");
                setManualId(next);
                setSelected(next ? Number(next) : null);
              }}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => qc.invalidateQueries({ queryKey: ["yz-groups-live"] })}
            disabled={yzQ.isFetching}
          >
            {yzQ.isFetching ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            从有赞刷新
          </Button>
          <Button
            size="sm"
            onClick={() => saveMut.mutate(saveId)}
            disabled={saveMut.isPending || !saveId || saveId === curQ.data?.id}
          >
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}


