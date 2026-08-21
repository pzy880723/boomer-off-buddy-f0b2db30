import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  History,
  Loader2,
  RefreshCw,
  Search,
  TicketCheck,
  UserRoundCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAuthSession } from "@/hooks/use-auth-session";
import { isSuperAdminPhone, resolveUserPhone } from "@/lib/auth-config";
import {
  adjustMembershipAdminBenefit,
  getMembershipAdminDetail,
  getMembershipAdminSummary,
  listMembershipAdminAudit,
  listMembershipAdminConsumption,
  listMembershipAdminCoupons,
  listMembershipAdminMembers,
  listMembershipAdminPlans,
  listMembershipAdminPoints,
} from "@/lib/membership/membership-admin.functions";

export const Route = createFileRoute("/operations/members")({
  head: () => ({ meta: [{ title: "会员管理 · BOOMER OFF" }] }),
  component: MembershipAdminPage,
});

type Section = "members" | "plans" | "coupons" | "points" | "consumption" | "audit";
type AdjustmentAction = "entitlement" | "points" | "coupon";
type MembershipRow = {
  id: string;
  member_no: string;
  masked_phone: string;
  nickname: string | null;
  tier_code: "free" | "explorer";
  tier_name: string;
  expiry_state: "free" | "active" | "expiring" | "expired";
  expires_at: string | null;
  auto_renew: boolean;
  source: string | null;
  recognition: { used: number; allowance: number; remaining: number };
  points: number;
  coupon_count: number;
  spend_90d_fen: number;
};
type MembershipPlanRow = {
  id: string;
  code: string;
  display_name: string;
  billing_period: string;
  amount_fen: number;
  first_period_amount_fen: number | null;
  renewal_amount_fen: number | null;
  daily_recognition_limit: number;
  official_discount_rate: number | string;
  points_multiplier: number | string;
  is_active: boolean;
};
type CouponDefinitionRow = {
  code: string;
  name: string;
  amount_fen: number;
  is_active: boolean;
};
type LedgerRow = Record<string, unknown> & { id?: string };
type MembershipDetail = {
  member: MembershipRow;
  consumption: LedgerRow[];
  entitlements: LedgerRow[];
  points: LedgerRow[];
  coupons: LedgerRow[];
  audit: LedgerRow[];
};

const sectionLabels: Record<Section, string> = {
  members: "会员列表",
  plans: "会员方案",
  coupons: "优惠券",
  points: "积分账本",
  consumption: "消费记录",
  audit: "变更审计",
};

function fen(value: unknown) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    Number(value || 0) / 100,
  );
}

function dateTime(value: unknown) {
  if (!value) return "—";
  return new Date(String(value)).toLocaleString("zh-CN", { hour12: false });
}

function expiryLabel(row: MembershipRow) {
  if (row.expiry_state === "free") return "长期";
  if (row.expiry_state === "expired") return "已过期";
  if (row.expiry_state === "expiring") return "7 天内到期";
  return row.expires_at ? `有效至 ${new Date(row.expires_at).toLocaleDateString("zh-CN")}` : "有效";
}

function MembershipAdminPage() {
  const queryClient = useQueryClient();
  const { session } = useAuthSession();
  const canAdjust = isSuperAdminPhone(resolveUserPhone(session?.user));
  const summaryFn = useServerFn(getMembershipAdminSummary);
  const membersFn = useServerFn(listMembershipAdminMembers);
  const detailFn = useServerFn(getMembershipAdminDetail);
  const plansFn = useServerFn(listMembershipAdminPlans);
  const couponsFn = useServerFn(listMembershipAdminCoupons);
  const pointsFn = useServerFn(listMembershipAdminPoints);
  const consumptionFn = useServerFn(listMembershipAdminConsumption);
  const auditFn = useServerFn(listMembershipAdminAudit);
  const adjustFn = useServerFn(adjustMembershipAdminBenefit);

  const [section, setSection] = useState<Section>("members");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState<"all" | "free" | "explorer">("all");
  const [status, setStatus] = useState<"all" | "active" | "expiring" | "expired" | "free">("all");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [adjustment, setAdjustment] = useState<AdjustmentAction | null>(null);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [planCode, setPlanCode] = useState("explorer_annual");
  const [expiresAt, setExpiresAt] = useState("");
  const [autoRenew, setAutoRenew] = useState(false);
  const [pointsDelta, setPointsDelta] = useState("");
  const [couponDefinition, setCouponDefinition] = useState("");

  const summaryQuery = useQuery({
    queryKey: ["membership-admin-summary"],
    queryFn: () => summaryFn(),
  });
  const membersQuery = useQuery({
    queryKey: ["membership-admin-members", search, tier, status],
    queryFn: () => membersFn({ data: { search: search || undefined, tier, status, limit: 300 } }),
  });
  const detailQuery = useQuery({
    queryKey: ["membership-admin-detail", selectedCustomerId],
    queryFn: () => detailFn({ data: { customer_id: selectedCustomerId! } }),
    enabled: Boolean(selectedCustomerId),
  });
  const plansQuery = useQuery({
    queryKey: ["membership-admin-plans"],
    queryFn: () => plansFn(),
  });
  const couponsQuery = useQuery({
    queryKey: ["membership-admin-coupons"],
    queryFn: () => couponsFn({ data: { limit: 300 } }),
    enabled: section === "coupons",
  });
  const pointsQuery = useQuery({
    queryKey: ["membership-admin-points"],
    queryFn: () => pointsFn({ data: { limit: 300 } }),
    enabled: section === "points",
  });
  const consumptionQuery = useQuery({
    queryKey: ["membership-admin-consumption"],
    queryFn: () => consumptionFn({ data: { limit: 300 } }),
    enabled: section === "consumption",
  });
  const auditQuery = useQuery({
    queryKey: ["membership-admin-audit"],
    queryFn: () => auditFn({ data: { limit: 300 } }),
    enabled: section === "audit",
  });

  const adjustmentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCustomerId || !adjustment) throw new Error("请先选择会员");
      const payload: Record<string, unknown> =
        adjustment === "entitlement"
          ? {
              plan_code: planCode,
              expires_at:
                planCode === "free" ? null : new Date(`${expiresAt}T23:59:59+08:00`).toISOString(),
              auto_renew: autoRenew,
            }
          : adjustment === "points"
            ? { delta: Number(pointsDelta) }
            : { definition_code: couponDefinition };
      return adjustFn({
        data: {
          customer_id: selectedCustomerId,
          action: adjustment,
          payload,
          reason,
          reference: reference || undefined,
          idempotency_key: crypto.randomUUID(),
        },
      });
    },
    onSuccess: () => {
      toast.success("会员权益已调整，并写入审计记录");
      setAdjustment(null);
      setReason("");
      setReference("");
      queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("membership-admin"),
      });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "会员权益调整失败"),
  });

  const summary = summaryQuery.data;
  const members = (membersQuery.data?.rows ?? []) as MembershipRow[];
  const detail = detailQuery.data as MembershipDetail | undefined;
  const plans = (plansQuery.data?.rows ?? []) as MembershipPlanRow[];
  const couponDefinitions = (plansQuery.data?.coupon_definitions ?? []) as CouponDefinitionRow[];
  const usageRate = summary?.recognition_allowance_today
    ? Math.round((summary.recognition_used_today / summary.recognition_allowance_today) * 100)
    : 0;
  const summaryCards: Array<{
    label: string;
    value: string | number;
    icon: LucideIcon;
    note: string;
  }> = [
    {
      label: "会员总数",
      value: summary?.member_count ?? "—",
      icon: Users,
      note: "全部有效消费者账号",
    },
    {
      label: "探索会员",
      value: summary?.explorer_count ?? "—",
      icon: BadgeCheck,
      note: summary
        ? `付费率 ${summary.member_count ? ((summary.explorer_count / summary.member_count) * 100).toFixed(1) : "0.0"}%`
        : "—",
    },
    {
      label: "7 天内到期",
      value: summary?.expiring_7d_count ?? "—",
      icon: CalendarClock,
      note: "需要会员召回",
    },
    {
      label: "今日识别",
      value: summary?.recognition_used_today ?? "—",
      icon: RefreshCw,
      note: `额度使用 ${usageRate}%`,
    },
    {
      label: "待使用优惠券",
      value: summary?.active_coupon_count ?? "—",
      icon: TicketCheck,
      note: summary ? `面值 ${fen(summary.active_coupon_value_fen)}` : "—",
    },
  ];

  const refreshAll = () =>
    queryClient.invalidateQueries({
      predicate: (query) => String(query.queryKey[0] ?? "").startsWith("membership-admin"),
    });
  const openAdjustment = (action: AdjustmentAction) => {
    if (!canAdjust) {
      toast.error("仅超级管理员可人工调整会员权益");
      return;
    }
    setAdjustment(action);
    if (action === "entitlement" && !expiresAt) {
      const nextYear = new Date();
      nextYear.setFullYear(nextYear.getFullYear() + 1);
      setExpiresAt(nextYear.toISOString().slice(0, 10));
    }
    if (action === "coupon" && !couponDefinition && couponDefinitions[0]?.code) {
      setCouponDefinition(couponDefinitions[0].code);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="会员管理"
        description="ERP 统一维护会员主档、权益、积分、优惠券与消费记录；有赞仅负责渠道执行和结果回传。"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              刷新
            </Button>
            <Button
              size="sm"
              disabled={!selectedCustomerId || !canAdjust}
              onClick={() => openAdjustment("entitlement")}
            >
              <UserRoundCog className="mr-1.5 h-3.5 w-3.5" />
              人工调整
            </Button>
          </div>
        }
      />

      <section className="overflow-hidden rounded-2xl bg-[#0a315d] p-5 text-white shadow-[0_6px_20px_rgba(10,49,93,0.16)]">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">会员运营总览</h2>
            <p className="mt-1 text-xs text-white/55">实时读取 ERP 会员主档</p>
          </div>
          {summaryQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-white/60" />}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {summaryCards.map(({ label, value, icon: Icon, note }) => (
            <div key={label} className="rounded-xl border border-white/10 bg-white/10 p-4">
              <Icon className="h-4 w-4 text-white/65" />
              <div className="mt-3 text-2xl font-bold tabular-nums">{value}</div>
              <div className="mt-1 text-xs text-white/65">{label}</div>
              <div className="mt-2 text-[10px] text-[#8df0bc]">{note}</div>
            </div>
          ))}
        </div>
      </section>

      <Tabs value={section} onValueChange={(value) => setSection(value as Section)}>
        <TabsList className="h-auto w-full justify-start rounded-none border-b bg-transparent p-0">
          {(Object.entries(sectionLabels) as Array<[Section, string]>).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="rounded-none border-b-2 border-transparent px-4 py-3 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="members" className="mt-4">
          <Card className="overflow-hidden rounded-2xl">
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center gap-3 border-b p-4">
                <div className="relative min-w-72 flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && setSearch(searchInput.trim())}
                    placeholder="搜索手机号、昵称、会员编号"
                    className="pl-9"
                  />
                </div>
                <Select value={tier} onValueChange={(value) => setTier(value as typeof tier)}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部等级</SelectItem>
                    <SelectItem value="free">好奇玩家</SelectItem>
                    <SelectItem value="explorer">探索会员</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="active">有效</SelectItem>
                    <SelectItem value="expiring">即将到期</SelectItem>
                    <SelectItem value="expired">已过期</SelectItem>
                    <SelectItem value="free">免费会员</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={() => setSearch(searchInput.trim())}>
                  筛选
                </Button>
                <span className="text-xs text-muted-foreground">
                  共 {membersQuery.data?.total ?? 0} 人
                </span>
              </div>
              {membersQuery.isLoading ? (
                <LoadingState />
              ) : membersQuery.isError ? (
                <ErrorState retry={() => membersQuery.refetch()} />
              ) : members.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="暂无匹配会员"
                  description="修改搜索或筛选条件后重试。"
                />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>会员</TableHead>
                        <TableHead>等级</TableHead>
                        <TableHead>有效期</TableHead>
                        <TableHead>今日识别</TableHead>
                        <TableHead className="text-right">积分</TableHead>
                        <TableHead className="text-right">优惠券</TableHead>
                        <TableHead className="text-right">近 90 天消费</TableHead>
                        <TableHead className="text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map((member) => (
                        <TableRow
                          key={member.id}
                          className="cursor-pointer"
                          onClick={() => setSelectedCustomerId(member.id)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#fee4e2] font-semibold text-[#b42318]">
                                {(member.nickname || member.masked_phone).slice(0, 1)}
                              </div>
                              <div>
                                <div className="font-medium">{member.nickname || "未设置昵称"}</div>
                                <div className="text-xs text-muted-foreground">
                                  {member.member_no} · {member.masked_phone}
                                </div>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={member.tier_code === "explorer" ? "default" : "secondary"}
                              className={
                                member.tier_code === "explorer"
                                  ? "bg-[#fff3df] text-[#8b5311] hover:bg-[#fff3df]"
                                  : ""
                              }
                            >
                              {member.tier_name}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={
                                member.expiry_state === "expiring"
                                  ? "border-[#fedf89] bg-[#fffaeb] text-[#b54708]"
                                  : member.expiry_state === "active"
                                    ? "border-[#abefc6] bg-[#ecfdf3] text-[#067647]"
                                    : ""
                              }
                            >
                              {expiryLabel(member)}
                            </Badge>
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {member.recognition.used} / {member.recognition.allowance}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {member.points.toLocaleString("zh-CN")}
                          </TableCell>
                          <TableCell className="text-right">{member.coupon_count} 张</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {fen(member.spend_90d_fen)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm">
                              查看详情
                              <ArrowRight className="ml-1 h-3.5 w-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="plans" className="mt-4">
          <PlansTable rows={plans} />
        </TabsContent>
        <TabsContent value="coupons" className="mt-4">
          <SimpleLedger
            title="优惠券发放记录"
            loading={couponsQuery.isLoading}
            rows={(couponsQuery.data?.rows ?? []) as LedgerRow[]}
            columns={["name", "code", "status", "value", "min_spend", "created_at"]}
          />
        </TabsContent>
        <TabsContent value="points" className="mt-4">
          <SimpleLedger
            title="积分账本"
            loading={pointsQuery.isLoading}
            rows={(pointsQuery.data?.rows ?? []) as LedgerRow[]}
            columns={[
              "customer_id",
              "delta",
              "balance_after",
              "source_type",
              "description",
              "created_at",
            ]}
          />
        </TabsContent>
        <TabsContent value="consumption" className="mt-4">
          <SimpleLedger
            title="消费记录"
            loading={consumptionQuery.isLoading}
            rows={(consumptionQuery.data?.rows ?? []) as LedgerRow[]}
            columns={[
              "customer_id",
              "channel",
              "gross_amount_fen",
              "discount_amount_fen",
              "paid_amount_fen",
              "occurred_at",
            ]}
          />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <SimpleLedger
            title="人工变更审计"
            loading={auditQuery.isLoading}
            rows={(auditQuery.data?.rows ?? []) as LedgerRow[]}
            columns={["customer_id", "action", "reason", "reference", "operator_id", "created_at"]}
          />
        </TabsContent>
      </Tabs>

      <Sheet
        open={Boolean(selectedCustomerId)}
        onOpenChange={(open) => !open && setSelectedCustomerId(null)}
      >
        <SheetContent className="w-[460px] overflow-y-auto sm:max-w-[460px]">
          <SheetHeader>
            <SheetTitle>{detail?.member?.nickname || "会员详情"}</SheetTitle>
            <SheetDescription>
              {detail?.member
                ? `${detail.member.member_no} · ${detail.member.masked_phone}`
                : "正在读取会员主档"}
            </SheetDescription>
          </SheetHeader>
          {detailQuery.isLoading ? (
            <LoadingState />
          ) : detailQuery.isError ? (
            <ErrorState retry={() => detailQuery.refetch()} />
          ) : detail?.member ? (
            <MemberDetail
              member={detail.member}
              detail={detail}
              canAdjust={canAdjust}
              onAdjust={openAdjustment}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <AdjustmentDialog
        open={Boolean(adjustment)}
        action={adjustment}
        onOpenChange={(open) => !open && setAdjustment(null)}
        plans={plans}
        couponDefinitions={couponDefinitions}
        planCode={planCode}
        setPlanCode={setPlanCode}
        expiresAt={expiresAt}
        setExpiresAt={setExpiresAt}
        autoRenew={autoRenew}
        setAutoRenew={setAutoRenew}
        pointsDelta={pointsDelta}
        setPointsDelta={setPointsDelta}
        couponDefinition={couponDefinition}
        setCouponDefinition={setCouponDefinition}
        reason={reason}
        setReason={setReason}
        reference={reference}
        setReference={setReference}
        pending={adjustmentMutation.isPending}
        onSubmit={() => adjustmentMutation.mutate()}
      />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex h-56 items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
function ErrorState({ retry }: { retry: () => void }) {
  return (
    <EmptyState
      icon={AlertCircle}
      title="数据加载失败"
      description="请检查网络后重试。"
      action={
        <Button variant="outline" onClick={retry}>
          重新加载
        </Button>
      }
    />
  );
}

function PlansTable({ rows }: { rows: MembershipPlanRow[] }) {
  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>方案</TableHead>
              <TableHead>周期</TableHead>
              <TableHead>首期价格</TableHead>
              <TableHead>续费价格</TableHead>
              <TableHead>每日识别</TableHead>
              <TableHead>官方折扣</TableHead>
              <TableHead>积分倍数</TableHead>
              <TableHead>状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="font-medium">{row.display_name}</div>
                  <div className="text-xs text-muted-foreground">{row.code}</div>
                </TableCell>
                <TableCell>{row.billing_period}</TableCell>
                <TableCell>{fen(row.first_period_amount_fen ?? row.amount_fen)}</TableCell>
                <TableCell>{fen(row.renewal_amount_fen ?? row.amount_fen)}</TableCell>
                <TableCell>{row.daily_recognition_limit} 次</TableCell>
                <TableCell>
                  {Math.round(Number(row.official_discount_rate) * 100) / 10} 折
                </TableCell>
                <TableCell>{Number(row.points_multiplier)} 倍</TableCell>
                <TableCell>
                  <Badge variant={row.is_active ? "default" : "secondary"}>
                    {row.is_active ? "启用" : "停用"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {rows.length === 0 && <EmptyState icon={BadgeCheck} title="暂无会员方案" />}
      </CardContent>
    </Card>
  );
}

function SimpleLedger({
  title,
  loading,
  rows,
  columns,
}: {
  title: string;
  loading: boolean;
  rows: LedgerRow[];
  columns: string[];
}) {
  const labels: Record<string, string> = {
    customer_id: "会员 ID",
    name: "名称",
    code: "编码",
    status: "状态",
    value: "面值",
    min_spend: "使用门槛",
    delta: "变动",
    balance_after: "变动后余额",
    source_type: "来源",
    description: "说明",
    channel: "渠道",
    gross_amount_fen: "原价",
    discount_amount_fen: "优惠",
    paid_amount_fen: "实付",
    action: "动作",
    reason: "原因",
    reference: "关联单号",
    operator_id: "操作人",
    created_at: "时间",
    occurred_at: "消费时间",
  };
  const render = (column: string, value: unknown) =>
    column.endsWith("_at")
      ? dateTime(value)
      : column.endsWith("_fen")
        ? fen(value)
        : column === "value" || column === "min_spend"
          ? `¥${Number(value || 0).toFixed(2)}`
          : String(value ?? "—");
  return (
    <Card className="overflow-hidden rounded-2xl">
      <div className="border-b px-5 py-4 font-semibold">{title}</div>
      <CardContent className="p-0">
        {loading ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState icon={History} title={`暂无${title}`} />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column}>{labels[column] ?? column}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={row.id ?? index}>
                    {columns.map((column) => (
                      <TableCell key={column} className="max-w-64 truncate">
                        {render(column, row[column])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MemberDetail({
  member,
  detail,
  canAdjust,
  onAdjust,
}: {
  member: MembershipRow;
  detail: MembershipDetail;
  canAdjust: boolean;
  onAdjust: (action: AdjustmentAction) => void;
}) {
  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-2xl bg-[#27231b] p-5 text-white">
        <div className="text-xs text-[#f4d58e]">BOOMER-OFF {member.tier_name}</div>
        <div className="mt-5 grid grid-cols-3 gap-3">
          <div>
            <div className="text-xl font-bold">{member.points.toLocaleString("zh-CN")}</div>
            <div className="text-[10px] text-white/50">可用积分</div>
          </div>
          <div>
            <div className="text-xl font-bold">{member.coupon_count}</div>
            <div className="text-[10px] text-white/50">优惠券</div>
          </div>
          <div>
            <div className="text-xl font-bold">
              {member.recognition.used}/{member.recognition.allowance}
            </div>
            <div className="text-[10px] text-white/50">今日识别</div>
          </div>
        </div>
      </div>
      <div className="rounded-xl border">
        <div className="flex justify-between border-b p-3 text-sm">
          <span className="text-muted-foreground">会员等级</span>
          <b>{member.tier_name}</b>
        </div>
        <div className="flex justify-between border-b p-3 text-sm">
          <span className="text-muted-foreground">有效期</span>
          <b>{expiryLabel(member)}</b>
        </div>
        <div className="flex justify-between border-b p-3 text-sm">
          <span className="text-muted-foreground">会员来源</span>
          <b>{member.source ?? "ERP"}</b>
        </div>
        <div className="flex justify-between p-3 text-sm">
          <span className="text-muted-foreground">自动续费</span>
          <b>{member.auto_renew ? "已开启" : "未开启"}</b>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" disabled={!canAdjust} onClick={() => onAdjust("entitlement")}>
          调整等级/有效期
        </Button>
        <Button variant="outline" disabled={!canAdjust} onClick={() => onAdjust("points")}>
          调整积分
        </Button>
        <Button variant="outline" disabled={!canAdjust} onClick={() => onAdjust("coupon")}>
          补发优惠券
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.info(`共 ${detail.consumption.length} 条消费记录`)}
        >
          查看消费流水
        </Button>
      </div>
      <div className="rounded-xl bg-[#fffaeb] p-3 text-xs leading-5 text-[#7a2e0e]">
        人工调整必须填写原因。系统会记录操作人、调整前后值、关联单号与时间，不允许覆盖或删除审计记录。
      </div>
    </div>
  );
}

function AdjustmentDialog(props: {
  open: boolean;
  action: AdjustmentAction | null;
  onOpenChange: (open: boolean) => void;
  plans: MembershipPlanRow[];
  couponDefinitions: CouponDefinitionRow[];
  planCode: string;
  setPlanCode: (value: string) => void;
  expiresAt: string;
  setExpiresAt: (value: string) => void;
  autoRenew: boolean;
  setAutoRenew: (value: boolean) => void;
  pointsDelta: string;
  setPointsDelta: (value: string) => void;
  couponDefinition: string;
  setCouponDefinition: (value: string) => void;
  reason: string;
  setReason: (value: string) => void;
  reference: string;
  setReference: (value: string) => void;
  pending: boolean;
  onSubmit: () => void;
}) {
  const valid =
    props.reason.trim().length >= 2 &&
    (props.action === "points"
      ? Number(props.pointsDelta) !== 0
      : props.action === "coupon"
        ? Boolean(props.couponDefinition)
        : props.planCode === "free" || Boolean(props.expiresAt));
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>人工调整会员权益</DialogTitle>
          <DialogDescription>
            仅超级管理员可操作；提交后同时写入业务账本和不可修改的审计记录。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {props.action === "entitlement" && (
            <>
              <div className="space-y-2">
                <Label>会员方案</Label>
                <Select value={props.planCode} onValueChange={props.setPlanCode}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {props.plans.map((plan) => (
                      <SelectItem key={plan.code} value={plan.code}>
                        {plan.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {props.planCode !== "free" && (
                <div className="space-y-2">
                  <Label>新有效期</Label>
                  <Input
                    type="date"
                    value={props.expiresAt}
                    onChange={(event) => props.setExpiresAt(event.target.value)}
                  />
                </div>
              )}
              <div className="flex items-center justify-between rounded-xl border p-3">
                <div>
                  <div className="text-sm font-medium">自动续费</div>
                  <div className="text-xs text-muted-foreground">
                    仅记录渠道状态，不主动发起扣款
                  </div>
                </div>
                <Switch checked={props.autoRenew} onCheckedChange={props.setAutoRenew} />
              </div>
            </>
          )}
          {props.action === "points" && (
            <div className="space-y-2">
              <Label>积分变动</Label>
              <Input
                type="number"
                value={props.pointsDelta}
                onChange={(event) => props.setPointsDelta(event.target.value)}
                placeholder="增加填正数，扣减填负数"
              />
            </div>
          )}
          {props.action === "coupon" && (
            <div className="space-y-2">
              <Label>优惠券</Label>
              <Select value={props.couponDefinition} onValueChange={props.setCouponDefinition}>
                <SelectTrigger>
                  <SelectValue placeholder="选择优惠券定义" />
                </SelectTrigger>
                <SelectContent>
                  {props.couponDefinitions
                    .filter((coupon) => coupon.is_active)
                    .map((coupon) => (
                      <SelectItem key={coupon.code} value={coupon.code}>
                        {coupon.name} · {fen(coupon.amount_fen)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>关联订单或工单号（可选）</Label>
            <Input
              value={props.reference}
              onChange={(event) => props.setReference(event.target.value)}
              placeholder="例如：CS20260821001"
            />
          </div>
          <div className="space-y-2">
            <Label>调整原因（必填）</Label>
            <Textarea
              value={props.reason}
              onChange={(event) => props.setReason(event.target.value)}
              placeholder="说明客诉、活动补偿或账务更正依据"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!valid || props.pending} onClick={props.onSubmit}>
            {props.pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}确认并写入审计
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
