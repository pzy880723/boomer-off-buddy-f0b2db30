import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Plus,
  Trash2,
  Zap,
  Activity,
  Store as StoreIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import {
  listYouzanShops,
  listYouzanSyncLogs,
  pingYouzanShop,
  addYouzanShop,
  removeYouzanShop,
} from "@/lib/youzan.functions";

export const Route = createFileRoute("/stores/youzan")({
  head: () => ({
    meta: [
      { title: "有赞对接 · 门店加盟" },
      { name: "description", content: "有赞连锁门店 API 同步状态" },
    ],
  }),
  component: YouzanPage,
});

function YouzanPage() {
  const qc = useQueryClient();
  const fetchShops = useServerFn(listYouzanShops);
  const fetchLogs = useServerFn(listYouzanSyncLogs);
  const pingFn = useServerFn(pingYouzanShop);
  const addFn = useServerFn(addYouzanShop);
  const removeFn = useServerFn(removeYouzanShop);

  const shopsQ = useQuery({
    queryKey: ["youzan-shops"],
    queryFn: () => fetchShops(),
  });
  const logsQ = useQuery({
    queryKey: ["youzan-sync-logs"],
    queryFn: () => fetchLogs({ data: { limit: 50 } }),
    refetchInterval: 5000,
  });

  const pingM = useMutation({
    mutationFn: (id: string) => pingFn({ data: { shop_id: id } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`连接成功 · ${r.message}`);
      else toast.error(`连接失败 · ${r.message}`);
      qc.invalidateQueries({ queryKey: ["youzan-shops"] });
      qc.invalidateQueries({ queryKey: ["youzan-sync-logs"] });
    },
  });

  const removeM = useMutation({
    mutationFn: (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["youzan-shops"] });
    },
  });

  const shops = shopsQ.data?.shops ?? [];
  const logs = logsQ.data?.logs ?? [];
  const hq = shops.find((s) => s.role === "hq");
  const branches = shops.filter((s) => s.role === "branch");

  return (
    <div>
      <PageHeader
        title="有赞对接"
        description="连锁门店：总部 + 分店统一管理。商品走总部，订单 / 库存走分店。"
        actions={
          <AddShopDialog
            hqKdtId={hq?.kdt_id ?? null}
            onAdd={async (input) => {
              await addFn({ data: input });
              toast.success("已添加门店");
              qc.invalidateQueries({ queryKey: ["youzan-shops"] });
            }}
          />
        }
      />

      <div className="mb-4 grid gap-4 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">
              已绑定门店
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">
              {shops.length}
            </p>
            <p className="text-[11px] text-muted-foreground">
              总部 {hq ? 1 : 0} · 分店 {branches.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">
              连通正常
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums text-success">
              {shops.filter((s) => s.last_ping_ok).length}
            </p>
            <p className="text-[11px] text-muted-foreground">
              失败 {shops.filter((s) => s.last_ping_ok === false).length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">
              client_id
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-xs">已配置（服务端）</p>
            <p className="text-[11px] text-muted-foreground">
              YOUZAN_CLIENT_ID / SECRET
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">
              下一步
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs">
              Phase 1：拉门店列表 + 拉订单
              <br />
              <span className="text-muted-foreground">
                先在有赞云后台把所有分店都授权一次
              </span>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <StoreIcon className="h-4 w-4 text-primary" />
            门店列表
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            每行 = 一个 kdt_id。点击「测试连接」会用 grant_type=silent 换取
            access_token 并调一次 youzan.shop.get/3.0.0 验证。
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            rowKey={(r) => r.id}
            data={shops}
              shopsQ.isLoading ? "加载中…" : "还没有添加任何门店，先点右上角「添加门店」"
            }
            columns={[
              {
                header: "店铺",
                cell: (r) => (
                  <div>
                    <p className="font-medium">{r.shop_name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      kdt_id: {r.kdt_id}
                    </p>
                  </div>
                ),
              },
              {
                header: "角色",
                cell: (r) =>
                  r.role === "hq" ? (
                    <Badge className="bg-primary/10 text-primary hover:bg-primary/15">
                      总部
                    </Badge>
                  ) : (
                    <Badge variant="outline">分店</Badge>
                  ),
              },
              {
                header: "授权有效期",
                cell: (r) =>
                  r.expires_at ? (
                    <span className="text-xs tabular-nums">
                      {new Date(r.expires_at).toLocaleDateString("zh-CN")}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  ),
              },
              {
                header: "Token 过期",
                cell: (r) =>
                  r.token_expires_at ? (
                    <span className="text-xs tabular-nums">
                      {new Date(r.token_expires_at).toLocaleString("zh-CN")}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">未获取</span>
                  ),
              },
              {
                header: "最近连通",
                cell: (r) => {
                  if (r.last_ping_at == null) {
                    return (
                      <span className="text-xs text-muted-foreground">
                        未测试
                      </span>
                    );
                  }
                  return (
                    <div className="flex items-center gap-1.5">
                      {r.last_ping_ok ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-destructive" />
                      )}
                      <span className="max-w-[260px] truncate text-xs" title={r.last_ping_msg ?? ""}>
                        {r.last_ping_msg ?? ""}
                      </span>
                    </div>
                  );
                },
              },
              {
                header: "操作",
                cell: (r) => (
                  <div className="flex items-center justify-end gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pingM.isPending && pingM.variables === r.id}
                      onClick={() => pingM.mutate(r.id)}
                    >
                      {pingM.isPending && pingM.variables === r.id ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Zap className="mr-1 h-3 w-3" />
                      )}
                      测试连接
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (confirm(`删除门店 ${r.shop_name}？`)) {
                          removeM.mutate(r.id);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                ),
                className: "text-right",
              },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" />
            同步日志（最近 50 条 · 5 秒自动刷新）
          </CardTitle>
        </CardHeader>
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
              { header: "动作", cell: (r) => <span className="text-xs">{r.action}</span> },
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
    </div>
  );
}

function AddShopDialog({
  hqKdtId,
  onAdd,
}: {
  hqKdtId: number | null;
  onAdd: (input: {
    kdt_id: number;
    shop_name: string;
    role: "hq" | "branch";
    parent_kdt_id?: number | null;
    notes?: string | null;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [kdt, setKdt] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"hq" | "branch">("branch");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-gradient-brand hover:opacity-90">
          <Plus className="mr-1 h-3.5 w-3.5" />
          添加门店
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加有赞门店</DialogTitle>
          <DialogDescription>
            在有赞云「自用型应用 → 测试店铺 / 授权信息」里授权过的店铺，把 kdt_id 录到这里。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div>
            <Label>kdt_id</Label>
            <Input
              value={kdt}
              onChange={(e) => setKdt(e.target.value.replace(/\D/g, ""))}
              placeholder="例如 153242272"
              className="font-mono"
            />
          </div>
          <div>
            <Label>店铺名称</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 BOOMER OFF 上海安福路店"
            />
          </div>
          <div>
            <Label>角色</Label>
            <Select value={role} onValueChange={(v) => setRole(v as "hq" | "branch")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hq">总部（HQ · 商品库统一管理）</SelectItem>
                <SelectItem value="branch">分店（订单 / 库存 在这）</SelectItem>
              </SelectContent>
            </Select>
            {role === "branch" && hqKdtId == null && (
              <p className="mt-1 text-[11px] text-warning">
                提醒：还没有"总部"门店。建议先添加一家 role=hq 的门店。
              </p>
            )}
          </div>
          <div>
            <Label>备注（可选）</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="例如 直营 / 加盟主信息等"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            disabled={pending || !kdt || !name}
            onClick={async () => {
              setPending(true);
              try {
                await onAdd({
                  kdt_id: Number(kdt),
                  shop_name: name.trim(),
                  role,
                  parent_kdt_id: role === "branch" ? hqKdtId : null,
                  notes: notes.trim() || null,
                });
                setOpen(false);
                setKdt("");
                setName("");
                setRole("branch");
                setNotes("");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "添加失败");
              } finally {
                setPending(false);
              }
            }}
          >
            {pending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
