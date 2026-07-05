import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Building2, Users, Bell, Plug, Webhook, Key, History, MapPin, RefreshCw, Loader2 } from "lucide-react";
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

