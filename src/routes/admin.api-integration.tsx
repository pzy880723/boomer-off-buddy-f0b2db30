import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import confetti from "canvas-confetti";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Play, RotateCcw, Pencil, ExternalLink, CheckCircle2, XCircle, Clock } from "lucide-react";
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

const PLATFORMS = [{ key: "youzan", name: "有赞" }] as const;

// 手工核对过的有赞文档 detail 页；命中直接跳该接口自己的文档。
const DOC_URL_BY_METHOD: Record<string, string> = {
  "auth/token": "https://doc.youzanyun.com/detail/API/0/906",
  "youzan.shop.chain.descendent.organization.list": "https://doc.youzanyun.com/detail/API/0/1793",
  "youzan.trades.sold.get": "https://doc.youzanyun.com/detail/API/0/70",
  "youzan.trade.get": "https://doc.youzanyun.com/detail/API/0/71",
  "youzan.retail.open.online.spu.query": "https://doc.youzanyun.com/detail/API/0/1790",
  "youzan.item.detail.get": "https://doc.youzanyun.com/detail/API/0/28",
  "youzan.retail.open.spu.create": "https://doc.youzanyun.com/detail/API/0/1788",
  "youzan.retail.open.spu.update": "https://doc.youzanyun.com/detail/API/0/1789",
  "youzan.retail.open.spu.delete": "https://doc.youzanyun.com/detail/API/0/1791",
  "youzan.item.quantity.update": "https://doc.youzanyun.com/detail/API/0/45",
  "youzan.materials.storage.platform.img.upload": "https://doc.youzanyun.com/detail/API/0/1233",
};

function docLinkFor(method: string, fallback?: string | null) {
  if (DOC_URL_BY_METHOD[method]) return DOC_URL_BY_METHOD[method];
  if (fallback && /^https?:\/\//.test(fallback)) return fallback;
  // 兜底：跳到文档中心分类列表页，让用户手动搜
  return `https://doc.youzanyun.com/list?keyword=${encodeURIComponent(method)}`;
}

// token 类型的中文表述
const TOKEN_ZH: Record<string, string> = { hq: "总部授权", branch: "分店授权", both: "总部或分店均可" };
const SCOPE_ZH: Record<string, string> = { hq: "只针对总部", branch: "只针对分店", both: "总部/分店都可以" };

function fireCelebration() {
  const end = Date.now() + 700;
  const colors = ["#22c55e", "#10b981", "#84cc16", "#facc15"];
  (function frame() {
    confetti({
      particleCount: 4,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.7 },
      colors,
    });
    confetti({
      particleCount: 4,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.7 },
      colors,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function ApiIntegrationPage() {
  const [platform, setPlatform] = useState<string>("youzan");
  return (
    <div className="space-y-4">
      <PageHeader
        title="API 对接"
        description="按平台一条条列出「我们要用哪个第三方接口做什么事」，右边直接选门店、填参数、点测试，就知道通不通。"
      />
      <Tabs value={platform} onValueChange={setPlatform}>
        <TabsList>
          {PLATFORMS.map((p) => (
            <TabsTrigger key={p.key} value={p.key}>{p.name}</TabsTrigger>
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

  if (q.isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在加载能力列表...
      </div>
    );
  if (q.error) return <div className="text-sm text-destructive">加载失败：{(q.error as Error).message}</div>;
  const { capabilities = [], last_probes = {}, shops = [] } = q.data ?? {};

  const passCount = capabilities.filter((c) => last_probes[c.capability_key]?.ok).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <Badge variant="outline" className="text-xs">共 {capabilities.length} 项能力</Badge>
        <Badge className="text-xs bg-emerald-600 hover:bg-emerald-600 gap-1">
          <CheckCircle2 className="h-3 w-3" />已通过 {passCount}
        </Badge>
        <span className="text-xs text-muted-foreground">
          左边看清「这一项能力我们要拿它做什么」，右边选真实店铺 + 填真实参数就能点【立即测试】。
        </span>
      </div>
      <div className="grid gap-4">
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
      if (r.ok) {
        fireCelebration();
        toast.success(`测试通过 · 耗时 ${r.latency_ms} 毫秒`);
      } else {
        const ex = explainProbeError({
          capability_key: cap.capability_key,
          method: cap.method,
          gw_code: r.gw_code ?? null,
          error: r.error ?? null,
          response_snippet: (r.response_snippet ?? "") as string,
        });
        toast.error(ex.title, { description: ex.reason });
      }
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reset = useMutation({
    mutationFn: () => resetFn({ data: { id: cap.id } }),
    onSuccess: () => {
      toast.success("已恢复到系统默认");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fields = PROBE_FIELDS[cap.capability_key] ?? [];
  const passed = lastProbe?.ok === true;
  const docHref = docLinkFor(cap.method, cap.doc_url);

  return (
    <Card
      className={
        "overflow-hidden transition-shadow " +
        (passed ? "border-emerald-500/40 shadow-[0_0_0_1px_rgb(16_185_129_/_25%)]" : "")
      }
    >
      <CardContent className="p-0">
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
          {/* 左：能力描述 */}
          <div className="p-5 space-y-3 bg-muted/20">
            <div className="flex items-start gap-2 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-base font-semibold leading-tight">{cap.capability_name}</h3>
                  <StatusPill probe={lastProbe} />
                  {cap.is_overridden && <Badge variant="destructive" className="text-[11px]">已改写</Badge>}
                </div>
                <p className="text-sm text-foreground/80 mt-2 leading-relaxed">{cap.requirement}</p>
              </div>
            </div>

            <details className="text-xs text-muted-foreground bg-background/40 border rounded-md">
              <summary className="cursor-pointer select-none px-2 py-1.5 text-foreground/70">
                技术信息（接口名 / 授权）
              </summary>
              <div className="px-2 pb-2 pt-1 space-y-1.5">
                <div>
                  <span>接口全名：</span>
                  <code className="font-mono text-foreground bg-background/60 border rounded px-1.5 py-0.5 break-all">
                    {cap.method}.{cap.version}
                  </code>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <InfoRow label="使用授权" value={TOKEN_ZH[cap.token_scope] ?? cap.token_scope} />
                  <InfoRow label="作用范围" value={SCOPE_ZH[cap.scope] ?? cap.scope} />
                </div>
                {cap.note && (
                  <div className="pt-1"><span className="text-foreground/70 font-medium">备注：</span>{cap.note}</div>
                )}
              </div>
            </details>

            <div className="flex items-center gap-1 pt-1">
              <Button variant="outline" size="sm" asChild>
                <a href={docHref} target="_blank" rel="noreferrer" className="gap-1">
                  <ExternalLink className="h-3.5 w-3.5" />查看有赞文档
                </a>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)} className="gap-1">
                <Pencil className="h-3.5 w-3.5" />修改配置
              </Button>
              {cap.is_overridden && (
                <Button variant="ghost" size="sm" onClick={() => reset.mutate()} disabled={reset.isPending} className="gap-1">
                  <RotateCcw className="h-3.5 w-3.5" />恢复默认
                </Button>
              )}
            </div>
          </div>

          {/* 右：测试面板 */}
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">立即测试</div>
              {lastProbe && (
                <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  上次测试 {new Date(lastProbe.tested_at).toLocaleString("zh-CN")}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs">用哪家门店测</Label>
              <Select value={shopId} onValueChange={setShopId}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="请选择门店" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleShops.length === 0 && (
                    <div className="text-xs text-muted-foreground p-2">
                      没有符合「{TOKEN_ZH[cap.token_scope]}」的门店
                    </div>
                  )}
                  {eligibleShops.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      [{s.role === "hq" ? "总部" : "分店"}] {s.shop_name} · {s.kdt_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {fields.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {fields.map((f) => (
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
                ))}
              </div>
            )}
            {fields.length === 0 && (
              <div className="text-xs text-muted-foreground border border-dashed rounded-md p-3">
                这一项不需要额外参数，选好门店后直接点【立即测试】即可。
              </div>
            )}

            <Button onClick={() => probe.mutate()} disabled={probe.isPending || !shopId} className="w-full gap-1">
              {probe.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              立即测试
            </Button>

            {(probe.data || lastProbe) && <ProbeResultBlock latest={probe.data} last={lastProbe} />}
          </div>
        </div>
      </CardContent>
      <EditDialog open={editOpen} onOpenChange={setEditOpen} cap={cap} onSaved={onChanged} />
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}：</span>
      <span>{value}</span>
    </div>
  );
}

function StatusPill({ probe }: { probe: ProbeRow | null }) {
  if (!probe) return <Badge variant="outline" className="text-[11px]">未测试</Badge>;
  return probe.ok ? (
    <Badge className="text-[11px] bg-emerald-600 hover:bg-emerald-600 gap-1">
      <CheckCircle2 className="h-3 w-3" />已通过
    </Badge>
  ) : (
    <Badge variant="destructive" className="text-[11px] gap-1">
      <XCircle className="h-3 w-3" />未通过
    </Badge>
  );
}

type ProbeExplanation = { title: string; reason: string; nextStep: string };

function explainProbeError(input: {
  capability_key: string;
  method: string;
  gw_code: number | null;
  error: string | null;
  response_snippet: string | null;
}): ProbeExplanation {
  const err = (input.error ?? "").trim();
  const snip = (input.response_snippet ?? "").trim();
  const all = `${err}\n${snip}`;
  const code = input.gw_code;

  // 前端参数校验类（handler 里直接抛的中文错误）
  if (/^请选择|^请填写/.test(err)) {
    return {
      title: "还有必填项没填",
      reason: err,
      nextStep: "在右侧「测试参数」里把缺的字段补上，再点一次「立即测试」。",
    };
  }
  if (/仓库查询接口所有版本都没有通过/.test(err)) {
    return {
      title: "仓库/库位查询还没有找到可用版本",
      reason: "系统已经自动测试了这个仓库接口的多个版本，但有赞都没有接受。销售库存同步不一定受影响，但实物仓库存相关能力暂时不能自动判断。",
      nextStep: "先用上方「一键检查店铺链路」确认授权和铺货渠道号；如果只差仓库接口，把技术细节里的版本结果发给有赞确认当前店铺支持哪个版本。",
    };
  }
  if (/此能力需要用.*token/.test(err)) {
    return {
      title: "选错店铺角色了",
      reason: err,
      nextStep: "顶部的店铺下拉里换成提示要求的那一类店（总部或分店）再测。",
    };
  }
  if (/必须选分店|需要在【分店】/.test(err)) {
    return {
      title: "这个能力只能对分店测",
      reason: err,
      nextStep: "把店铺切换成一家分店再点测试。",
    };
  }

  // 有赞网关错误码
  if (code === 234000001 || /系统异常/.test(all)) {
    return {
      title: "有赞暂时拒绝了这次调用（系统异常）",
      reason: "有赞返回了 234000001「系统异常」。通常不是我们发的参数有问题，而是这个 SPU 在有赞后台被锁、店铺零售配置异常，或有赞侧临时故障。",
      nextStep: "过几分钟重试一次；仍失败就换一个新建的测试 SPU；再不行把下面的 trace_id 发给有赞客服排查。",
    };
  }
  if (code === 301000002 || /item.*not.*found|商品不存在|not visible/i.test(all)) {
    return {
      title: "分店还查不到这个商品",
      reason: "有赞说这个商品在分店那边不存在或还没显示出来。多半是总部 SPU 还没铺到这家分店，或刚铺完有赞索引没跟上。",
      nextStep: "先在门店列表里对这家分店做一次「铺货 / 同步」，等 1–2 分钟再来测。",
    };
  }
  if (code === 40009 || /access[_ ]?token|token.*(expire|invalid)|unauthorized/i.test(all)) {
    return {
      title: "店铺授权失效了",
      reason: "有赞说 access_token 无效或过期。这家店的授权已经不能再用了。",
      nextStep: "去「门店列表」找到这家店，点「重新绑定」重新走一次有赞授权。",
    };
  }
  if (code && code >= 40000 && code < 50000) {
    return {
      title: "有赞说我们发的请求不合法",
      reason: `有赞返回错误码 ${code}。多半是接口版本、参数名或字段类型不对。`,
      nextStep: "看看这个能力的「接口全名 / 版本」是不是有赞文档里最新的；对照文档改一下参数再测。",
    };
  }
  if (/HTTP\s*5\d\d|gateway|proxy|ETIMEDOUT|ECONNRESET|network/i.test(all)) {
    return {
      title: "网络没通到有赞",
      reason: "请求还没到有赞业务层就失败了，通常是出口代理或有赞网关临时抖动。",
      nextStep: "过一会儿再点一次；如果一直这样，去检查有赞出口代理是否在线。",
    };
  }

  // 兜底
  return {
    title: "测试没通过，但有赞没给出明确原因",
    reason: err || "有赞没有返回可读的错误信息。",
    nextStep: "展开下面的「技术细节」，把 trace_id 和返回内容发给有赞客服，让他们帮忙查这一次请求。",
  };
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

  const explain = !shown.ok
    ? explainProbeError({
        capability_key: "",
        method: "",
        gw_code: shown.gw_code ?? null,
        error: shown.error ?? null,
        response_snippet: (shown.response_snippet ?? "") as string,
      })
    : null;

  const copyTrace = async () => {
    if (!shown.trace_id) return;
    try {
      await navigator.clipboard.writeText(shown.trace_id);
      toast.success("trace_id 已复制");
    } catch {
      toast.error("复制失败，请手动选中");
    }
  };

  return (
    <div
      className={
        "mt-1 rounded-md border p-3 space-y-3 " +
        (shown.ok ? "bg-emerald-500/5 border-emerald-500/30" : "bg-destructive/5 border-destructive/30")
      }
    >
      <div className="flex items-center gap-3 text-xs">
        <span className={shown.ok ? "text-emerald-600 font-medium" : "text-destructive font-medium"}>
          {shown.ok ? "✓ 测试通过" : "✗ 测试失败"}
        </span>
        <span className="text-muted-foreground">耗时 {shown.latency_ms} 毫秒</span>
        {shown.gw_code != null && <span className="text-muted-foreground">有赞错误码 {shown.gw_code}</span>}
      </div>

      {explain && (
        <div className="space-y-2 text-sm">
          <div>
            <span className="font-medium">结论：</span>
            <span>{explain.title}</span>
          </div>
          <div className="text-muted-foreground">
            <span className="font-medium text-foreground">原因：</span>
            {explain.reason}
          </div>
          <div className="text-muted-foreground">
            <span className="font-medium text-foreground">下一步：</span>
            {explain.nextStep}
          </div>
          {shown.trace_id && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>trace_id：</span>
              <code className="px-1.5 py-0.5 rounded bg-background border">{shown.trace_id}</code>
              <button type="button" className="underline hover:text-foreground" onClick={copyTrace}>
                复制
              </button>
            </div>
          )}
        </div>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">技术细节（发给客服 / 开发排查用）</summary>
        <div className="mt-2 space-y-2">
          {shown.error && (
            <div>
              <div className="text-muted-foreground mb-1">原始错误：</div>
              <pre className="p-2 bg-background rounded border overflow-auto max-h-40 whitespace-pre-wrap break-all">{shown.error}</pre>
            </div>
          )}
          {shown.response_snippet && (
            <div>
              <div className="text-muted-foreground mb-1">有赞返回：</div>
              <pre className="p-2 bg-background rounded border overflow-auto max-h-40 whitespace-pre-wrap break-all">{shown.response_snippet}</pre>
            </div>
          )}
          {shown.request_params && Object.keys(shown.request_params as any).length > 0 && (
            <div>
              <div className="text-muted-foreground mb-1">发送的参数：</div>
              <pre className="p-2 bg-background rounded border overflow-auto max-h-40">{JSON.stringify(shown.request_params, null, 2)}</pre>
            </div>
          )}
        </div>
      </details>
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
  const [fullName, setFullName] = useState(`${cap.method}.${cap.version}`);
  const [scope, setScope] = useState(cap.scope);
  const [tokenScope, setTokenScope] = useState(cap.token_scope);
  const [note, setNote] = useState(cap.note ?? "");
  const updateFn = useServerFn(updateIntegrationCapability);

  // 校验：xxx.yyy.zzz.<major>.<minor>.<patch>
  const FULL_NAME_RE = /^([a-zA-Z0-9_.]+)\.(\d+)\.(\d+)\.(\d+)$/;
  const match = fullName.trim().match(FULL_NAME_RE);
  const parsed = match
    ? { method: match[1], version: `${match[2]}.${match[3]}.${match[4]}` }
    : null;

  const mut = useMutation({
    mutationFn: () => {
      if (!parsed) throw new Error("接口全名格式不对");
      return updateFn({
        data: { id: cap.id, method: parsed.method, version: parsed.version, scope, token_scope: tokenScope, note },
      });
    },
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
          <DialogTitle>修改配置：{cap.capability_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">接口全名</Label>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="youzan.retail.open.stocksupply.relaiton.query.1.0.0"
              className="font-mono"
            />
            <p className={"text-[11px] mt-1 " + (parsed || !fullName ? "text-muted-foreground" : "text-destructive")}>
              {parsed
                ? `将保存为：接口名 ${parsed.method} · 版本 ${parsed.version}`
                : "格式应为：接口名.主版本.次版本.修订版本，例如 youzan.trades.sold.get.4.0.4"}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">作用范围</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hq">只针对总部</SelectItem>
                  <SelectItem value="branch">只针对分店</SelectItem>
                  <SelectItem value="both">总部/分店都可以</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label className="text-xs">使用哪种授权</Label>
              <Select value={tokenScope} onValueChange={(v) => setTokenScope(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="hq">总部授权</SelectItem>
                  <SelectItem value="branch">分店授权</SelectItem>
                  <SelectItem value="both">总部或分店均可</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">备注 / 踩过的坑</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !parsed}>
            {mut.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// 每个能力的测试参数字段（中文标签）
// ------------------------------------------------------------
type ProbeField = { key: string; label: string; placeholder?: string; hint?: string; required?: boolean; defaultValue?: string };

const PROBE_FIELDS: Record<string, ProbeField[]> = {
  "auth.silent_token": [],
  "shop.chain.descendent.organization.list": [],
  "retail.open.warehouse.query": [
    { key: "page_no", label: "第几页", defaultValue: "1" },
    { key: "page_size", label: "每页取几条", defaultValue: "20", hint: "系统会自动连续测试 3.0.1 / 3.0.0 / 1.0.1 / 1.0.0。" },
  ],
  "trades.sold.get": [
    { key: "hours", label: "回看多少小时的订单", placeholder: "24", defaultValue: "24" },
    { key: "page_size", label: "每页取几条", placeholder: "5", defaultValue: "5" },
  ],
  "trade.get": [
    { key: "tid", label: "订单号（tid）", required: true, placeholder: "E20260101..." },
  ],
  "retail.open.online.spu.query": [
    {
      key: "page_size",
      label: "每页取几条",
      defaultValue: "5",
      hint: "在门店列表里选一家分店，会用总部授权 + 分店 kdt_id 去反查这家分店在售的商品。",
    },
  ],
  "item.detail.get": [
    {
      key: "item_id",
      label: "分店 item_id",
      required: true,
      hint: "必须填分店真实的 item_id，不能填总部 spu_id，否则会报 [301000002]。",
    },
  ],
  "retail.open.spu.create": [
    {
      key: "category_id",
      label: "有赞零售类目 ID",
      required: true,
      placeholder: "例如 20000123",
      hint: "必填。可以在有赞后台的类目管理里看到。",
    },
    { key: "name", label: "商品名（可留空）", placeholder: "留空会自动生成【探针】" },
    { key: "spu_code", label: "商品编码（可留空）", placeholder: "留空会自动生成 probe-xxx" },
    { key: "retail_price", label: "零售价", defaultValue: "0.01" },
  ],
  "retail.open.spu.update": [
    { key: "spu_id", label: "总部 SPU ID", required: true },
    {
      key: "sell_channel_id",
      label: "目标销售渠道 ID",
      required: true,
      hint: "从上面「查询总部下的门店组织树」的返回里找 organizations[].sell_channel_id。",
    },
  ],
  "retail.open.spu.delete": [
    {
      key: "spu_codes",
      label: "要删除的商品编码",
      required: true,
      placeholder: "多个用英文逗号分隔",
      hint: "危险操作：会真的把有赞总部的 SPU 删掉。",
    },
  ],
  "item.quantity.update": [
    { key: "item_id", label: "分店 item_id", required: true },
    {
      key: "sku_id",
      label: "分店 sku_id",
      required: true,
      hint: "商品没有多规格时，把 sku_id 填成跟 item_id 一样的值。",
    },
    {
      key: "stock_num",
      label: "要覆盖成的库存数量",
      required: true,
      hint: "这个接口是「全量覆盖」；填等于当前库存的数字就是原样写回。",
    },
  ],
  "materials.storage.platform.img.upload": [
    {
      key: "image_url",
      label: "测试图片链接",
      required: true,
      placeholder: "https://...jpg",
      hint: "系统会把这张图下载下来再上传到有赞素材库，成功后返回 img.yzcdn.cn 的地址。",
    },
  ],
};
