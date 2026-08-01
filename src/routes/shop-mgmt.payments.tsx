import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, CheckCircle2, Loader2, QrCode, ShieldCheck, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
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
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import {
  listStorePaymentsFn,
  reviewStorePaymentSubjectFn,
  saveStorePaymentProfileFn,
  submitStorePaymentSubjectFn,
  updateWechatPaymentStatusFn,
  type StorePaymentOverview,
} from "@/lib/store-payments.functions";

export const Route = createFileRoute("/shop-mgmt/payments")({
  head: () => ({
    meta: [
      { title: "门店支付 · 门店管理" },
      { name: "description", content: "自有门店营业主体、支付码与微信支付申请管理" },
    ],
  }),
  component: StorePaymentsPage,
});

const verificationLabel = {
  draft: "资料待提交",
  pending: "ERP 认证中",
  approved: "ERP 已认证",
  rejected: "ERP 已驳回",
} as const;

const providerLabel = {
  not_applied: "未申请微信支付",
  applying: "微信审核中",
  active: "微信已开通",
  rejected: "微信审核未通过",
  suspended: "微信支付已停用",
} as const;

function verificationTone(status: keyof typeof verificationLabel) {
  if (status === "approved") return "success" as const;
  if (status === "rejected") return "danger" as const;
  if (status === "pending") return "warning" as const;
  return "neutral" as const;
}

function providerTone(status: keyof typeof providerLabel) {
  if (status === "active") return "success" as const;
  if (status === "rejected" || status === "suspended") return "danger" as const;
  if (status === "applying") return "warning" as const;
  return "neutral" as const;
}

function StorePaymentsPage() {
  const list = useServerFn(listStorePaymentsFn);
  const query = useQuery({ queryKey: ["store-payment-profiles"], queryFn: () => list() });
  const [editing, setEditing] = useState<StorePaymentOverview | null>(null);
  const [providerEditing, setProviderEditing] = useState<StorePaymentOverview | null>(null);
  const stores = useMemo(() => query.data ?? [], [query.data]);
  const summary = useMemo(
    () => ({
      total: stores.length,
      verified: stores.filter((store) => store.subject?.erp_verification_status === "approved")
        .length,
      ready: stores.filter((store) => store.ready_for_payment).length,
    }),
    [stores],
  );

  return (
    <div>
      <PageHeader
        title="门店支付"
        description="每家 ERP 门店绑定一个营业主体和一个支付码；实际收款按订单生成动态二维码"
        meta={<span>当前只管理 BOOMER OFF 自有门店，暂不包含寄售商家与市集摊主</span>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <SummaryCard icon={Building2} label="ERP 门店" value={summary.total} suffix="家" />
        <SummaryCard icon={ShieldCheck} label="主体已认证" value={summary.verified} suffix="家" />
        <SummaryCard
          icon={CheckCircle2}
          label="支付已就绪"
          value={summary.ready}
          suffix="家"
          emphasis
        />
      </div>

      <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-950">
        <p className="font-medium">支付主体由 ERP 统一认证和管理</p>
        <p className="mt-1 text-xs leading-5 text-blue-800">
          ERP 负责门店与营业执照主体的绑定、申请资料校验和微信审核结果归档。微信 APIv3
          密钥与证书只存服务器 Secret，不会下发到网页、APP 或收银机。
        </p>
      </div>

      {query.isLoading ? (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在读取门店支付配置
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-destructive">{String(query.error)}</p>
            <Button className="mt-4" variant="outline" onClick={() => query.refetch()}>
              重新加载
            </Button>
          </CardContent>
        </Card>
      ) : stores.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            ERP 尚未建立启用中的门店库位，请先在“库位管理”新增门店。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {stores.map((store) => (
            <StorePaymentCard
              key={store.location.id}
              store={store}
              onEdit={() => setEditing(store)}
              onProviderEdit={() => setProviderEditing(store)}
            />
          ))}
        </div>
      )}

      <SubjectDialog store={editing} onClose={() => setEditing(null)} />
      <ProviderDialog store={providerEditing} onClose={() => setProviderEditing(null)} />
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  suffix,
  emphasis = false,
}: {
  icon: typeof Building2;
  label: string;
  value: number;
  suffix: string;
  emphasis?: boolean;
}) {
  return (
    <Card className={emphasis ? "border-emerald-200 bg-emerald-50/40" : undefined}>
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={`rounded-xl p-2.5 ${emphasis ? "bg-emerald-100 text-emerald-700" : "bg-muted"}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums">
            {value}
            <span className="ml-1 text-xs font-normal text-muted-foreground">{suffix}</span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function StorePaymentCard({
  store,
  onEdit,
  onProviderEdit,
}: {
  store: StorePaymentOverview;
  onEdit: () => void;
  onProviderEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const submit = useServerFn(submitStorePaymentSubjectFn);
  const review = useServerFn(reviewStorePaymentSubjectFn);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["store-payment-profiles"] });
  const submitMutation = useMutation({
    mutationFn: () => submit({ data: { subject_id: store.subject!.id } }),
    onSuccess: () => {
      toast.success("已提交 ERP 主体认证");
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const reviewMutation = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      review({ data: { subject_id: store.subject!.id, decision } }),
    onSuccess: (_, decision) => {
      toast.success(decision === "approved" ? "主体已通过 ERP 认证" : "主体资料已驳回");
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const verification = store.subject?.erp_verification_status ?? "draft";
  const provider = store.subject?.provider_application_status ?? "not_applied";

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-start justify-between gap-3 border-b bg-muted/25 p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
              <WalletCards className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate font-semibold">{store.location.name}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">ERP 门店 · 每店一个支付码</p>
            </div>
          </div>
          <StatusBadge tone={store.ready_for_payment ? "success" : "warning"}>
            {store.ready_for_payment ? "可收款" : "未开通"}
          </StatusBadge>
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div>
              <p className="text-[11px] text-muted-foreground">营业主体</p>
              <p className="mt-1 text-sm font-medium">{store.subject?.legal_name ?? "尚未配置"}</p>
              {store.subject && (
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {store.subject.unified_social_credit_code}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <StatusBadge tone={verificationTone(verification)}>
                {verificationLabel[verification]}
              </StatusBadge>
              <StatusBadge tone={providerTone(provider)}>{providerLabel[provider]}</StatusBadge>
            </div>
            {store.subject?.wechat_sub_mchid && (
              <p className="text-xs text-muted-foreground">
                微信子商户号 · ****{store.subject.wechat_sub_mchid.slice(-4)}
              </p>
            )}
          </div>
          <div className="min-w-44 rounded-xl border border-dashed bg-background p-3 text-center">
            <QrCode className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-[10px] text-muted-foreground">ERP 门店支付码</p>
            <p className="mt-1 font-mono text-xs font-semibold">
              {store.profile?.payment_code ?? "配置后生成"}
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">收款时生成订单专属二维码</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" size="sm" onClick={onEdit}>
            {store.profile ? "修改主体资料" : "配置支付主体"}
          </Button>
          {store.subject && ["draft", "rejected"].includes(verification) && (
            <Button
              size="sm"
              onClick={() => submitMutation.mutate()}
              disabled={submitMutation.isPending}
            >
              提交 ERP 认证
            </Button>
          )}
          {store.subject && verification === "pending" && (
            <>
              <Button variant="outline" size="sm" onClick={() => reviewMutation.mutate("rejected")}>
                驳回资料
              </Button>
              <Button size="sm" onClick={() => reviewMutation.mutate("approved")}>
                认证通过
              </Button>
            </>
          )}
          {store.subject && verification === "approved" && (
            <Button size="sm" onClick={onProviderEdit}>
              记录微信申请状态
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type SubjectForm = {
  subject_type: "enterprise" | "individual_business";
  legal_name: string;
  unified_social_credit_code: string;
  legal_representative_name: string;
  contact_name: string;
  contact_phone: string;
};

const emptySubjectForm: SubjectForm = {
  subject_type: "enterprise",
  legal_name: "",
  unified_social_credit_code: "",
  legal_representative_name: "",
  contact_name: "",
  contact_phone: "",
};

function SubjectDialog({
  store,
  onClose,
}: {
  store: StorePaymentOverview | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const save = useServerFn(saveStorePaymentProfileFn);
  const [form, setForm] = useState<SubjectForm>(emptySubjectForm);
  useEffect(() => {
    if (!store) return;
    setForm(
      store.subject
        ? {
            subject_type: store.subject.subject_type,
            legal_name: store.subject.legal_name,
            unified_social_credit_code: store.subject.unified_social_credit_code,
            legal_representative_name: store.subject.legal_representative_name,
            contact_name: store.subject.contact_name,
            contact_phone: store.subject.contact_phone,
          }
        : emptySubjectForm,
    );
  }, [store]);
  const mutation = useMutation({
    mutationFn: () => save({ data: { location_id: store!.location.id, ...form } }),
    onSuccess: (result) => {
      toast.success(result.reset_verification ? "资料已保存，请重新提交认证" : "支付主体已建立");
      queryClient.invalidateQueries({ queryKey: ["store-payment-profiles"] });
      onClose();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const set = (key: keyof SubjectForm, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <Dialog open={Boolean(store)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{store?.location.name} · 支付主体</DialogTitle>
        </DialogHeader>
        {store?.subject?.erp_verification_status === "approved" && (
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            修改已认证的主体资料会撤销当前认证和微信绑定，需要重新提交审核。
          </div>
        )}
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <Field label="主体类型">
            <Select value={form.subject_type} onValueChange={(value) => set("subject_type", value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="enterprise">企业</SelectItem>
                <SelectItem value="individual_business">个体工商户</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="营业执照名称">
            <Input value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} />
          </Field>
          <Field label="统一社会信用代码">
            <Input
              value={form.unified_social_credit_code}
              onChange={(e) => set("unified_social_credit_code", e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="法定代表人 / 经营者">
            <Input
              value={form.legal_representative_name}
              onChange={(e) => set("legal_representative_name", e.target.value)}
            />
          </Field>
          <Field label="申请联系人">
            <Input
              value={form.contact_name}
              onChange={(e) => set("contact_name", e.target.value)}
            />
          </Field>
          <Field label="联系人手机号">
            <Input
              inputMode="tel"
              value={form.contact_phone}
              onChange={(e) => set("contact_phone", e.target.value.replace(/\D/g, "").slice(0, 11))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}保存主体资料
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderDialog({
  store,
  onClose,
}: {
  store: StorePaymentOverview | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const update = useServerFn(updateWechatPaymentStatusFn);
  const [status, setStatus] = useState<
    "not_applied" | "applying" | "active" | "rejected" | "suspended"
  >("not_applied");
  const [applicationId, setApplicationId] = useState("");
  const [merchantId, setMerchantId] = useState("");
  const [appid, setAppid] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!store?.subject) return;
    setStatus(store.subject.provider_application_status);
    setApplicationId(store.subject.provider_application_id ?? "");
    setMerchantId(store.subject.wechat_sub_mchid ?? "");
    setAppid(store.subject.wechat_appid ?? "");
    setNote(store.subject.provider_status_note ?? "");
  }, [store]);
  const mutation = useMutation({
    mutationFn: () =>
      update({
        data: {
          subject_id: store!.subject!.id,
          status,
          provider_application_id: applicationId || null,
          wechat_sub_mchid: merchantId || null,
          wechat_appid: appid || null,
          note: note || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("微信支付申请状态已更新");
      queryClient.invalidateQueries({ queryKey: ["store-payment-profiles"] });
      onClose();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <Dialog open={Boolean(store)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{store?.location.name} · 微信支付申请</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <Field label="微信审核状态">
            <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(providerLabel).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="微信申请单号">
              <Input value={applicationId} onChange={(e) => setApplicationId(e.target.value)} />
            </Field>
            <Field label="微信支付子商户号">
              <Input value={merchantId} onChange={(e) => setMerchantId(e.target.value)} />
            </Field>
          </div>
          <Field label="收款 AppID">
            <Input value={appid} onChange={(e) => setAppid(e.target.value)} />
          </Field>
          <Field label="审核备注">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <p className="text-xs leading-5 text-muted-foreground">
            这里只记录微信审核结果和公开商户标识，不填写 APIv3 密钥、商户私钥或证书。
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            保存微信状态
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
