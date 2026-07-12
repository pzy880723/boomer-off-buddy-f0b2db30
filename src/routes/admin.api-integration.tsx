import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Play, RotateCcw, Pencil, ExternalLink, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import {
  listIntegrationCapabilities,
  updateIntegrationCapability,
  resetIntegrationCapability,
  probeIntegrationCapability,
  type CapabilityRow,
  type ProbeRow,
} from "@/lib/integration-capabilities.functions";

export const Route = createFileRoute("/admin/api-integration")({
  head: () => ({
    meta: [
      { title: "API 对接 · 系统" },
      { name: "description", content: "第三方 API 能力矩阵：精确配置、精确测试。" },
    ],
  }),
  component: ApiIntegrationPage,
});

type ShopLite = { id: string; kdt_id: number; shop_name: string; role: "hq" | "branch"; status: string };

const PLATFORMS = [
  { key: "youzan", name: "有赞", desc: "连锁零售 · 总部 + 分店" },
] as const;

function ApiIntegrationPage() {
  const [platform, setPlatform] = useState<string>("youzan");

  return (
    <div className="space-y-4">
      <PageHeader
        title="API 对接"
        description="按平台维度维护 API 能力矩阵：左边讲清楚这个能力要做什么，右边就用真参数打一次。"
      />
      <Tabs value={platform} onValueChange={setPlatform}>
        <TabsList>
          {PLATFORMS.map((p) => (
            <TabsTrigger key={p.key} value={p.key}>
              {p.name}
            </TabsTrigger>
          ))}
        </TabsList>
        {PLATFORMS.map((p) => (
          <TabsContent key={p.key} value={p.key} className="mt-4">
            <PlatformMatrix platform={p.key} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function PlatformMatrix({ platform }: { platform: string }) {
  const fetchList = useServerFn(listIntegrationCapabilities);
  const q = useQuery({
    queryKey: ["integration-capabilities", platform],
    queryFn: () => fetchList({ data: { platform } }),
  });

  if (q.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载能力矩阵中...</div>;
  if (q.error) return <div className="text-sm text-destructive">加载失败：{(q.error as Error).message}</div>;
  const { capabilities = [], last_probes = {}, shops = [] } = q.data ?? {};

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        共 {capabilities.length} 个能力。左侧「能力/需求」是我们对这个 API 的精准描述；右侧填真实参数点【测试】就会用当前店铺 token 打一次。
      </div>
      <div className="grid gap-3">
        {capabilities.map((cap) => (
          <CapabilityCard
            key={cap.id}
            cap={cap}
            lastProbe={last_probes[cap.capability_key] ?? null}
            shops={shops}
            onChanged={() => q.refetch()}
          />
        ))}
      </div>
    </div>
  );
}

function CapabilityCard({
  cap,
  lastProbe,
  shops,
  onChanged,
}: {
  cap: CapabilityRow;
  lastProbe: ProbeRow | null;
  shops: ShopLite[];
  onChanged: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const eligibleShops = useMemo(() => {
    if (cap.token_scope === "hq") return shops.filter((s) => s.role === "hq");
    if (cap.token_scope === "branch") return shops.filter((s) => s.role === "branch");
    return shops;
  }, [cap.token_scope, shops]);
  const defaultShopId = eligibleShops[0]?.id ?? "";
  const [shopId, setShopId] = useState<string>(defaultShopId);
  // update state if shops load after mount
  if (!shopId && defaultShopId) setShopId(defaultShopId);

  const [params, setParams] = useState<Record<string, string>>({});
  const probeFn = useServerFn(probeIntegrationCapability);
  const resetFn = useServerFn(resetIntegrationCapability);

  const probe = useMutation({
    mutationFn: async () => {
      const cleaned: Record<string, any> = {};
      Object.entries(params).forEach(([k, v]) => {
        if (v === "" || v === null || v === undefined) return;
        cleaned[k] = v;
      });
      return probeFn({ data: { id: cap.id, shop_id: shopId || null, params: cleaned } });
    },
    onSuccess: (r) => {
      if (r.ok) toast.success(`测试通过 · ${cap.method}/${cap.version} · ${r.latency_ms}ms`);
      else toast.error(r.error ?? "测试失败");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reset = useMutation({
    mutationFn: () => resetFn({ data: { id: cap.id } }),
    onSuccess: () => {
      toast.success("已恢复内置默认");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fields = PROBE_FIELDS[cap.capability_key] ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">{cap.capability_name}</CardTitle>
              <Badge variant="outline" className="font-mono text-[11px]">{cap.method}</Badge>
              <Badge variant="secondary" className="font-mono text-[11px]">v{cap.version}</Badge>
              <Badge variant="outline" className="text-[11px]">
                token: {cap.token_scope === "hq" ? "总部" : cap.token_scope === "branch" ? "分店" : "均可"}
              </Badge>
              {cap.is_overridden && <Badge variant="destructive" className="text-[11px]">已改写</Badge>}
              <StatusPill probe={lastProbe} />
            </div>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{cap.requirement}</p>
            {cap.note && (
              <p className="text-xs text-muted-foreground/80 mt-1 leading-relaxed">
                <span className="text-foreground/60">备注：</span>{cap.note}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {cap.doc_url && (
              <Button variant="ghost" size="sm" asChild>
                <a href={cap.doc_url} target="_blank" rel="noreferrer" className="gap-1">
                  <ExternalLink className="h-3.5 w-3.5" />文档
                </a>
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)} className="gap-1">
              <Pencil className="h-3.5 w-3.5" />编辑
            </Button>
            {cap.is_overridden && (
              <Button variant="ghost" size="sm" onClick={() => reset.mutate()} disabled={reset.isPending} className="gap-1">
                <RotateCcw className="h-3.5 w-3.5" />恢复默认
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr_auto] gap-3 items-end">
          <div>
            <Label className="text-xs">测试店铺</Label>
            <Select value={shopId} onValueChange={setShopId}>
              <SelectTrigger className="h-9"><SelectValue placeholder="选店铺" /></SelectTrigger>
              <SelectContent>
                {eligibleShops.length === 0 && <div className="text-xs text-muted-foreground p-2">没有符合 token 类型的店铺</div>}
                {eligibleShops.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    [{s.role === "hq" ? "总部" : "分店"}] {s.shop_name} · {s.kdt_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {fields.length === 0 ? (
              <div className="text-xs text-muted-foreground py-2">此测试无需额外参数。</div>
            ) : (
              fields.map((f) => (
                <div key={f.key}>
                  <Label className="text-xs">
                    {f.label}
                    {f.required && <span className="text-destructive ml-1">*</span>}
                  </Label>
                  <Input
                    className="h-9"
                    placeholder={f.placeholder}
                    value={params[f.key] ?? f.defaultValue ?? ""}
                    onChange={(e) => setParams((p) => ({ ...p, [f.key]: e.target.value }))}
                  />
                  {f.hint && <p className="text-[11px] text-muted-foreground mt-0.5">{f.hint}</p>}
                </div>
              ))
            )}
          </div>
          <Button onClick={() => probe.mutate()} disabled={probe.isPending || !shopId} className="gap-1">
            {probe.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            测试
          </Button>
        </div>
        {(probe.data || lastProbe) && <ProbeResultBlock latest={probe.data} last={lastProbe} />}
      </CardContent>
      <EditDialog open={editOpen} onOpenChange={setEditOpen} cap={cap} onSaved={onChanged} />
    </Card>
  );
}

function StatusPill({ probe }: { probe: ProbeRow | null }) {
  if (!probe) return <Badge variant="outline" className="text-[11px]">未测</Badge>;
  return probe.ok ? (
    <Badge className="text-[11px] bg-emerald-600 hover:bg-emerald-600 gap-1"><CheckCircle2 className="h-3 w-3" />通</Badge>
  ) : (
    <Badge variant="destructive" className="text-[11px] gap-1"><XCircle className="h-3 w-3" />失败</Badge>
  );
}

function ProbeResultBlock({
  latest,
  last,
}: {
  latest: Awaited<ReturnType<ReturnType<typeof useServerFn<typeof probeIntegrationCapability>>>> | undefined;
  last: ProbeRow | null;
}) {
  const shown = latest ?? (last
    ? {
        ok: last.ok,
        latency_ms: last.latency_ms ?? 0,
        trace_id: last.trace_id,
        gw_code: last.gw_code,
        error: last.error,
        response_snippet: last.response_snippet ?? "",
        request_params: last.request_params ?? {},
      }
    : null);
  if (!shown) return null;
  return (
    <div className="mt-3 rounded-md border p-3 bg-muted/30 space-y-2">
      <div className="flex items-center gap-3 text-xs">
        <span className={shown.ok ? "text-emerald-600 font-medium" : "text-destructive font-medium"}>
          {shown.ok ? "✓ 通过" : "✗ 失败"}
        </span>
        <span className="text-muted-foreground">{shown.latency_ms}ms</span>
        {shown.gw_code && <span className="text-muted-foreground">code={shown.gw_code}</span>}
        {shown.trace_id && <span className="text-muted-foreground font-mono">trace={shown.trace_id}</span>}
      </div>
      {shown.error && <div className="text-xs text-destructive whitespace-pre-wrap break-all">{shown.error}</div>}
      {shown.response_snippet && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">响应片段</summary>
          <pre className="mt-1 p-2 bg-background rounded border overflow-auto max-h-64 whitespace-pre-wrap break-all">{shown.response_snippet}</pre>
        </details>
      )}
      {shown.request_params && Object.keys(shown.request_params as any).length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">请求参数</summary>
          <pre className="mt-1 p-2 bg-background rounded border overflow-auto max-h-64">{JSON.stringify(shown.request_params, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function EditDialog({
  open,
  onOpenChange,
  cap,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  cap: CapabilityRow;
  onSaved: () => void;
}) {
  const [method, setMethod] = useState(cap.method);
  const [version, setVersion] = useState(cap.version);
  const [scope, setScope] = useState(cap.scope);
  const [tokenScope, setTokenScope] = useState(cap.token_scope);
  const [note, setNote] = useState(cap.note ?? "");
  const updateFn = useServerFn(updateIntegrationCapability);
  const mut = useMutation({
    mutationFn: () =>
      updateFn({
        data: { id: cap.id, method, version, scope, token_scope: tokenScope, note },
      }),
    onSuccess: () => {
      toast.success("已保存");
      onOpenChange(false);
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑：{cap.capability_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">method</Label>
              <Input value={method} onChange={(e) => setMethod(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">version</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hq">hq（总部）</SelectItem>
                  <SelectItem value="branch">branch（分店）</SelectItem>
                  <SelectItem value="both">both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">token_scope</Label>
              <Select value={tokenScope} onValueChange={(v) => setTokenScope(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hq">hq token</SelectItem>
                  <SelectItem value="branch">branch token</SelectItem>
                  <SelectItem value="both">任一</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">备注</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// 每个能力的测试参数字段（用户看到啥就填啥）
// ------------------------------------------------------------
type ProbeField = { key: string; label: string; placeholder?: string; hint?: string; required?: boolean; defaultValue?: string };

const PROBE_FIELDS: Record<string, ProbeField[]> = {
  "auth.silent_token": [],
  "shop.chain.descendent.organization.list": [],
  "trades.sold.get": [
    { key: "hours", label: "回看小时数", placeholder: "24", defaultValue: "24" },
    { key: "page_size", label: "每页条数", placeholder: "5", defaultValue: "5" },
  ],
  "trade.get": [{ key: "tid", label: "订单号 tid", required: true, placeholder: "E20260101..." }],
  "retail.open.online.spu.query": [
    { key: "page_size", label: "每页", placeholder: "5", defaultValue: "5", hint: "选一家分店即可，用 HQ token + 分店 kdt_id 反查。" },
  ],
  "item.detail.get": [
    { key: "item_id", label: "分店 item_id", required: true, hint: "必须是分店真实 item_id，不能是 HQ spu_id。" },
  ],
  "retail.open.spu.create": [
    { key: "category_id", label: "有赞类目 ID", required: true, placeholder: "如 20000123", hint: "必填。可以从有赞后台或 shoptree.query 里取。" },
    { key: "name", label: "商品名（可空）", placeholder: "留空自动生成【探针】" },
    { key: "spu_code", label: "spu_code（可空）", placeholder: "留空自动生成 probe-xxx" },
    { key: "retail_price", label: "零售价", defaultValue: "0.01" },
  ],
  "retail.open.spu.update": [
    { key: "spu_id", label: "HQ spu_id", required: true },
    { key: "sell_channel_id", label: "目标 sell_channel_id", required: true, hint: "从 shop.chain.descendent 里取分店的 sell_channel_id。" },
  ],
  "retail.open.spu.delete": [
    { key: "spu_codes", label: "spu_codes", required: true, placeholder: "多个用逗号分隔", hint: "危险操作：会真的从有赞删除 SPU。" },
  ],
  "item.quantity.update": [
    { key: "item_id", label: "分店 item_id", required: true },
    { key: "sku_id", label: "分店 sku_id", required: true, hint: "无 SKU 时填 item_id 同值。" },
    { key: "stock_num", label: "覆盖库存值", required: true, hint: "全量覆盖，等于当前值就是原样写回。" },
  ],
  "materials.storage.platform.img.upload": [
    { key: "image_url", label: "测试图片 URL", required: true, placeholder: "https://...jpg", hint: "服务器会拉这张图并 base64 上传到有赞素材库。" },
  ],
};
