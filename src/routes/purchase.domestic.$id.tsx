import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { ArrowLeft, Save, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { PageHeader } from "@/components/page-header";
import {
  getDomesticOrder,
  updateDomesticOrder,
  removeDomesticOrder,
  PLATFORMS,
  PLATFORM_LABEL,
  STATUSES,
  STATUS_LABEL,
  type DomesticPlatform,
  type DomesticStatus,
} from "@/lib/domestic-orders.functions";

export const Route = createFileRoute("/purchase/domestic/$id")({
  head: () => ({ meta: [{ title: "订单详情 · 国内渠道" }] }),
  component: DomesticDetailPage,
});

type Patch = Record<string, unknown>;

function DomesticDetailPage() {
  const { id } = Route.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const getFn = useServerFn(getDomesticOrder);
  const updateFn = useServerFn(updateDomesticOrder);
  const removeFn = useServerFn(removeDomesticOrder);

  const q = useQuery({
    queryKey: ["domestic-order", id],
    queryFn: () => getFn({ data: { id } }),
  });

  const [form, setForm] = useState<Patch>({});

  useEffect(() => {
    if (q.data) setForm(q.data as Patch);
  }, [q.data]);

  const updateMut = useMutation({
    mutationFn: () => {
      const { id: _id, created_at, updated_at, deleted_at, completeness, ...patch } = form as Record<string, unknown>;
      void _id;
      void created_at;
      void updated_at;
      void deleted_at;
      void completeness;
      return updateFn({ data: { id, patch: patch as never } });
    },
    onSuccess: () => {
      toast.success("已保存");
      qc.invalidateQueries({ queryKey: ["domestic-order", id] });
      qc.invalidateQueries({ queryKey: ["domestic-orders"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const removeMut = useMutation({
    mutationFn: () => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["domestic-orders"] });
      nav({ to: "/purchase/domestic" });
    },
  });

  if (q.isLoading) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;
  if (!q.data) return <div className="p-6 text-sm text-destructive">订单不存在</div>;

  const screenshots = (form.screenshot_urls as string[] | null) ?? [];

  const set = (k: string, v: unknown) => setForm((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-4">
      <PageHeader
        title={(form.item_title as string) || "(无标题)"}
        description={`平台：${PLATFORM_LABEL[form.platform as DomesticPlatform] ?? form.platform}  ·  单号：${form.source_order_no ?? "-"}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => nav({ to: "/purchase/domestic" })}>
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> 返回
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => {
                if (confirm("确定删除该订单？")) removeMut.mutate();
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> 删除
            </Button>
            <Button
              size="sm"
              className="bg-gradient-brand hover:opacity-90"
              disabled={updateMut.isPending}
              onClick={() => updateMut.mutate()}
            >
              {updateMut.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              保存
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-3 py-4">
            <h3 className="text-sm font-semibold">订单信息</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Selector
                label="平台"
                value={form.platform as string}
                onChange={(v) => set("platform", v)}
                options={PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABEL[p] }))}
              />
              <Selector
                label="状态"
                value={form.status as string}
                onChange={(v) => set("status", v)}
                options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              />
              <FormField label="订单号" value={form.source_order_no as string | null} onChange={(v) => set("source_order_no", v)} />
              <FormField label="商品标题" value={form.item_title as string | null} onChange={(v) => set("item_title", v)} className="md:col-span-2" />
              <FormField label="卖家" value={form.seller_name as string | null} onChange={(v) => set("seller_name", v)} />
              <FormField label="卖家 handle" value={form.seller_handle as string | null} onChange={(v) => set("seller_handle", v)} />
              <NumberField label="单价 ¥" value={form.price_cny as number | null} onChange={(v) => set("price_cny", v)} />
              <NumberField label="运费 ¥" value={form.shipping_cny as number | null} onChange={(v) => set("shipping_cny", v)} />
              <NumberField label="实付 ¥" value={form.total_cny as number | null} onChange={(v) => set("total_cny", v)} />
              <NumberField label="数量" value={form.qty as number | null} onChange={(v) => set("qty", v)} />
              <FormField label="下单时间" value={form.purchased_at as string | null} onChange={(v) => set("purchased_at", v)} />
              <FormField label="物流单号" value={form.tracking_no as string | null} onChange={(v) => set("tracking_no", v)} />
              <FormField label="快递" value={form.carrier as string | null} onChange={(v) => set("carrier", v)} />
              <FormField label="收件人" value={form.receiver_name as string | null} onChange={(v) => set("receiver_name", v)} />
              <FormField label="收件电话" value={form.receiver_phone as string | null} onChange={(v) => set("receiver_phone", v)} />
              <FormField label="收件地址" value={form.receiver_address as string | null} onChange={(v) => set("receiver_address", v)} className="md:col-span-3" />
            </div>

            {form.platform === "wechat" && (
              <div>
                <Label className="text-xs">聊天摘要</Label>
                <Textarea
                  rows={3}
                  value={(form.chat_summary as string) ?? ""}
                  onChange={(e) => set("chat_summary", e.target.value || null)}
                  className="text-xs"
                />
              </div>
            )}
            <div>
              <Label className="text-xs">备注</Label>
              <Textarea
                rows={2}
                value={(form.notes as string) ?? ""}
                onChange={(e) => set("notes", e.target.value || null)}
                className="text-xs"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 py-4">
            <h3 className="text-sm font-semibold">截图 ({screenshots.length})</h3>
            {screenshots.length === 0 ? (
              <p className="text-xs text-muted-foreground">无截图</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {screenshots.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer" className="rounded border p-1 hover:border-primary">
                    <img src={url} alt="" className="h-32 w-full rounded object-cover" />
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FormField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="text-xs">{label}</Label>
      <Input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 text-xs"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        step="0.01"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="h-8 text-xs tabular-nums"
      />
    </div>
  );
}

function Selector({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
