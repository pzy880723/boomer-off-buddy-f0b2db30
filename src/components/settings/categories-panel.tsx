import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  RefreshCw,
  Plus,
  Trash2,
  PowerOff,
  Power,
  Link2,
  Loader2,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  listCategories,
  upsertCategory,
  setCategoryActive,
  deleteCategory,
  previewYouzanCategorySync,
  applyYouzanCategorySync,
  type CategoryRow,
} from "@/lib/categories.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type PreviewRes = Awaited<ReturnType<typeof previewYouzanCategorySync>>;

export function CategoriesPanel() {
  const qc = useQueryClient();
  const list = useServerFn(listCategories);
  const upsert = useServerFn(upsertCategory);
  const setActive = useServerFn(setCategoryActive);
  const del = useServerFn(deleteCategory);
  const preview = useServerFn(previewYouzanCategorySync);
  const apply = useServerFn(applyYouzanCategorySync);

  const q = useQuery({ queryKey: ["inv-categories"], queryFn: () => list() });
  const rows: CategoryRow[] = q.data?.rows ?? [];

  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const invalidate = () => qc.invalidateQueries({ queryKey: ["inv-categories"] });

  const toggleActive = useMutation({
    mutationFn: (r: CategoryRow) => setActive({ data: { id: r.id, is_active: !r.is_active } }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "操作失败"),
  });
  const removeCat = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "删除失败"),
  });

  // ---- Youzan sync ----
  const [syncOpen, setSyncOpen] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewRes | null>(null);
  const [pickAdd, setPickAdd] = useState<Record<number, boolean>>({});
  const [pickUpd, setPickUpd] = useState<Record<string, boolean>>({});
  const [pickDeact, setPickDeact] = useState<Record<string, boolean>>({});
  const [codeOverride, setCodeOverride] = useState<Record<number, string>>({});
  const [syncing, setSyncing] = useState(false);

  const runPreview = async () => {
    setSyncing(true);
    try {
      const res = await preview();
      setPreviewData(res);
      const a: Record<number, boolean> = {};
      res.to_add.forEach((x) => (a[x.yz.id] = true));
      const u: Record<string, boolean> = {};
      res.to_update.forEach((x) => (u[x.local.id] = true));
      const d: Record<string, boolean> = {};
      res.to_deactivate.forEach((x) => (d[x.id] = false));
      setPickAdd(a);
      setPickUpd(u);
      setPickDeact(d);
      setSyncOpen(true);
      if (res.blocking) {
        if (res.blocking.kind === "ip_whitelist") {
          toast.error("有赞侧未加白名单，见弹窗说明");
        } else if (res.blocking.kind === "no_api") {
          toast.error("当前授权无店铺分组接口权限");
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "预览失败");
    } finally {
      setSyncing(false);
    }
  };
  const runApply = async () => {
    if (!previewData) return;
    setSyncing(true);
    try {
      const add = previewData.to_add
        .filter((x) => pickAdd[x.yz.id])
        .map((x) => ({
          youzan_hq_category_id: x.yz.id,
          youzan_hq_parent_id: x.yz.parent_id ?? null,
          name: x.yz.name,
          code: (codeOverride[x.yz.id] ?? x.suggest_code).trim() || x.suggest_code,
        }));
      const update = previewData.to_update
        .filter((x) => pickUpd[x.local.id])
        .map((x) => ({ id: x.local.id, name: x.yz.name }));
      const deactivate = previewData.to_deactivate
        .filter((x) => pickDeact[x.id])
        .map((x) => x.id);
      const r = await apply({
        data: { shop_id: previewData.shop_id, add, update, deactivate },
      });
      toast.success(`同步完成：新增 ${r.added} · 更新 ${r.updated} · 停用 ${r.deactivated}`);
      setSyncOpen(false);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  };

  // 构建树：一级 → 子级
  const tree = useMemo(() => {
    const byParent = new Map<string | null, CategoryRow[]>();
    for (const r of rows) {
      const pid = r.parent_id ?? null;
      const arr = byParent.get(pid) ?? [];
      arr.push(r);
      byParent.set(pid, arr);
    }
    const sortFn = (a: CategoryRow, b: CategoryRow) =>
      a.sort_order - b.sort_order || a.name.localeCompare(b.name);
    for (const [, arr] of byParent) arr.sort(sortFn);
    const roots = byParent.get(null) ?? [];
    return { roots, byParent };
  }, [rows]);

  // 预览：按父分组
  const previewAddGroups = useMemo(() => {
    if (!previewData) return [] as {
      key: string;
      title: string;
      items: PreviewRes["to_add"];
    }[];
    const map = new Map<string, PreviewRes["to_add"]>();
    for (const x of previewData.to_add) {
      const key = x.yz.parent_id ? String(x.yz.parent_id) : "__root__";
      const title = x.yz.parent_id
        ? `子分组 · ${x.parent_name ?? `#${x.yz.parent_id}`}`
        : "一级分组";
      const arr = map.get(key) ?? [];
      arr.push(x);
      map.set(key, arr);
      // 记录 title
      (arr as unknown as { __title?: string }).__title = title;
    }
    return Array.from(map.entries()).map(([key, items]) => ({
      key,
      title: (items as unknown as { __title?: string }).__title ?? "分组",
      items,
    }));
  }, [previewData]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">商品分组</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            对应有赞后台【商品 → 分组管理】里店铺自建的分组，不是平台标准类目。ERP 是唯一真源，可从有赞总部一键拉取后手动采纳；停用后新建商品不再显示。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={runPreview} disabled={syncing}>
            {syncing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            从有赞拉取店铺分组
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新建分组
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border divide-y">
          {q.isLoading && (
            <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>
          )}
          {!q.isLoading && tree.roots.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">暂无分组</div>
          )}
          {tree.roots.map((r) => {
            const kids = tree.byParent.get(r.id) ?? [];
            const isOpen = !collapsed[r.id];
            return (
              <div key={r.id}>
                <CategoryRowView
                  row={r}
                  depth={0}
                  hasChildren={kids.length > 0}
                  isOpen={isOpen}
                  onToggleOpen={() =>
                    setCollapsed((s) => ({ ...s, [r.id]: !collapsed[r.id] }))
                  }
                  childCount={kids.length}
                  onToggleActive={() => toggleActive.mutate(r)}
                  onEdit={() => setEditing(r)}
                  onDelete={() => {
                    if (confirm(`确定删除分组「${r.name}」？`)) removeCat.mutate(r.id);
                  }}
                />
                {isOpen &&
                  kids.map((k) => (
                    <CategoryRowView
                      key={k.id}
                      row={k}
                      depth={1}
                      hasChildren={false}
                      onToggleActive={() => toggleActive.mutate(k)}
                      onEdit={() => setEditing(k)}
                      onDelete={() => {
                        if (confirm(`确定删除分组「${k.name}」？`)) removeCat.mutate(k.id);
                      }}
                    />
                  ))}
              </div>
            );
          })}
        </div>
      </CardContent>

      {/* 编辑 / 新建 */}
      <EditDialog
        open={creating || !!editing}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        initial={editing}
        parents={rows.filter(
          (r) => r.is_active && r.parent_id === null && (!editing || r.id !== editing.id),
        )}
        onSave={async (payload) => {
          try {
            await upsert({ data: payload });
            toast.success("已保存");
            invalidate();
            setCreating(false);
            setEditing(null);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "保存失败");
          }
        }}
      />

      {/* 同步预览 */}
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>有赞店铺分组同步预览</DialogTitle>
            <DialogDescription>
              {previewData
                ? `使用接口 ${previewData.api} · 待新增 ${previewData.to_add.length} · 待更新 ${previewData.to_update.length} · 待停用 ${previewData.to_deactivate.length}`
                : "加载中…"}
            </DialogDescription>
          </DialogHeader>
          {previewData && (
            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              {previewData.blocking && <BlockingErrorAlert blocking={previewData.blocking} onRetry={runPreview} retrying={syncing} />}
              {previewData.notes && previewData.notes.length > 0 && (
                <div className="rounded-md border border-muted bg-muted/30 px-3 py-2 text-[11px] space-y-1">
                  {previewData.notes.map((n, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                      <span>{n.status === "ok" ? "✅" : n.status === "no_api" ? "⚠️" : n.status === "ip_blocked" ? "🚫" : n.status === "empty" ? "◌" : "❌"}</span>
                      <span className="font-mono text-[10px] shrink-0 text-muted-foreground">{n.api}</span>
                      <span className="text-muted-foreground break-all">— {n.message}{n.count != null ? `（${n.count} 条）` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
              <Section title={`新增（${previewData.to_add.length}）`}>
                {previewAddGroups.length === 0 && (
                  <p className="text-xs text-muted-foreground">无</p>
                )}
                {previewAddGroups.map((g) => (
                  <div key={g.key} className="mb-2 last:mb-0">
                    <div className="text-[11px] font-medium text-muted-foreground mb-1">
                      {g.title}
                    </div>
                    {g.items.map((x) => (
                      <div
                        key={x.yz.id}
                        className={`flex items-center gap-3 py-1 text-sm ${
                          x.yz.parent_id ? "pl-4" : ""
                        }`}
                      >
                        <Checkbox
                          checked={!!pickAdd[x.yz.id]}
                          onCheckedChange={(v) =>
                            setPickAdd((s) => ({ ...s, [x.yz.id]: !!v }))
                          }
                        />
                        <span className="flex-1 truncate">
                          {x.yz.parent_id && (
                            <span className="text-muted-foreground mr-1">└</span>
                          )}
                          {x.yz.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          有赞 #{x.yz.id}
                        </span>
                        <Input
                          className="h-7 w-28 font-mono text-xs"
                          value={codeOverride[x.yz.id] ?? x.suggest_code}
                          onChange={(e) =>
                            setCodeOverride((s) => ({ ...s, [x.yz.id]: e.target.value }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </Section>
              <Section title={`更新名称（${previewData.to_update.length}）`}>
                {previewData.to_update.map((x) => (
                  <div key={x.local.id} className="flex items-center gap-3 py-1 text-sm">
                    <Checkbox
                      checked={!!pickUpd[x.local.id]}
                      onCheckedChange={(v) =>
                        setPickUpd((s) => ({ ...s, [x.local.id]: !!v }))
                      }
                    />
                    <span className="flex-1 truncate">
                      <span className="text-muted-foreground line-through mr-2">
                        {x.local.name}
                      </span>
                      → <span className="font-medium">{x.yz.name}</span>
                    </span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {x.local.code}
                    </Badge>
                  </div>
                ))}
                {previewData.to_update.length === 0 && (
                  <p className="text-xs text-muted-foreground">无</p>
                )}
              </Section>
              <Section title={`有赞已删除，可停用（${previewData.to_deactivate.length}）`}>
                {previewData.to_deactivate.map((x) => (
                  <div key={x.id} className="flex items-center gap-3 py-1 text-sm">
                    <Checkbox
                      checked={!!pickDeact[x.id]}
                      onCheckedChange={(v) =>
                        setPickDeact((s) => ({ ...s, [x.id]: !!v }))
                      }
                    />
                    <span className="flex-1 truncate">{x.name}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {x.code}
                    </Badge>
                  </div>
                ))}
                {previewData.to_deactivate.length === 0 && (
                  <p className="text-xs text-muted-foreground">无</p>
                )}
              </Section>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSyncOpen(false)}>
              取消
            </Button>
            <Button onClick={runApply} disabled={syncing || !previewData}>
              {syncing && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              采纳勾选项
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CategoryRowView({
  row,
  depth,
  hasChildren,
  isOpen,
  onToggleOpen,
  childCount,
  onToggleActive,
  onEdit,
  onDelete,
}: {
  row: CategoryRow;
  depth: 0 | 1;
  hasChildren: boolean;
  isOpen?: boolean;
  onToggleOpen?: () => void;
  childCount?: number;
  onToggleActive: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 text-sm ${
        depth === 1 ? "bg-muted/20 pl-10" : ""
      }`}
    >
      {depth === 0 ? (
        hasChildren ? (
          <button
            type="button"
            onClick={onToggleOpen}
            className="text-muted-foreground hover:text-foreground"
          >
            {isOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="inline-block w-3.5" />
        )
      ) : (
        <span className="text-muted-foreground">└</span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={
              row.is_active
                ? "font-medium"
                : "font-medium text-muted-foreground line-through"
            }
          >
            {row.name}
          </span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.code}
          </Badge>
          {row.is_system && (
            <Badge variant="secondary" className="text-[10px]">
              系统
            </Badge>
          )}
          {row.youzan_hq_category_id && (
            <Badge variant="outline" className="text-[10px] gap-1">
              <Link2 className="h-3 w-3" /> 有赞 #{row.youzan_hq_category_id}
            </Badge>
          )}
          {depth === 0 && childCount ? (
            <Badge variant="secondary" className="text-[10px]">
              含 {childCount} 个子分组
            </Badge>
          ) : null}
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5">
          排序 {row.sort_order}
          {row.synced_at
            ? ` · 同步于 ${new Date(row.synced_at).toLocaleString("zh-CN")}`
            : ""}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onToggleActive}>
        {row.is_active ? (
          <>
            <PowerOff className="mr-1 h-3.5 w-3.5" />
            停用
          </>
        ) : (
          <>
            <Power className="mr-1 h-3.5 w-3.5" />
            启用
          </>
        )}
      </Button>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        编辑
      </Button>
      {!row.is_system && (
        <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{title}</div>
      <div className="rounded border p-2">{children}</div>
    </div>
  );
}

function EditDialog({
  open,
  onOpenChange,
  initial,
  parents,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: CategoryRow | null;
  parents: CategoryRow[];
  onSave: (p: {
    id?: string;
    code: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
    is_active: boolean;
  }) => void;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [parent, setParent] = useState<string>(initial?.parent_id ?? "");
  const [sort, setSort] = useState<string>(String(initial?.sort_order ?? 100));
  const [active, setActive] = useState<boolean>(initial?.is_active ?? true);

  // 弹窗打开或 initial 变化时重置字段
  useEffect(() => {
    if (!open) return;
    setCode(initial?.code ?? "");
    setName(initial?.name ?? "");
    setParent(initial?.parent_id ?? "");
    setSort(String(initial?.sort_order ?? 100));
    setActive(initial?.is_active ?? true);
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "编辑分组" : "新建分组"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>名称 *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>短码 *</Label>
              <Input
                className="font-mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="如 JP / EU / TY"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>排序</Label>
              <Input type="number" value={sort} onChange={(e) => setSort(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>上级分组</Label>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={parent}
                onChange={(e) => setParent(e.target.value)}
              >
                <option value="">— 顶级 —</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border p-2">
            <span className="text-sm">启用</span>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() =>
              onSave({
                id: initial?.id,
                code: code.trim(),
                name: name.trim(),
                parent_id: parent || null,
                sort_order: Number(sort) || 0,
                is_active: active,
              })
            }
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type BlockingErrorLike =
  | { kind: "ip_whitelist"; ip: string; apis: string[]; raw: string }
  | { kind: "no_api"; apis: string[] }
  | { kind: "other"; message: string };

function BlockingErrorAlert({
  blocking,
  onRetry,
  retrying,
}: {
  blocking: BlockingErrorLike;
  onRetry: () => void;
  retrying: boolean;
}) {
  const copy = (t: string) => {
    navigator.clipboard.writeText(t).then(() => toast.success("已复制"));
  };
  if (blocking.kind === "ip_whitelist") {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-3 text-sm">
        <div>
          <div className="font-medium text-destructive">有赞侧未加 IP 白名单</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            下方是云端动态出口 IP，发布后也不保证固定，不建议反复加入白名单。请配置固定出口代理后，只把代理固定 IP 加到有赞白名单。
          </div>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded bg-muted px-2 py-1.5 font-mono text-sm">{blocking.ip || "(未识别到 IP)"}</code>
          <Button size="sm" variant="outline" onClick={() => copy(blocking.ip)} disabled={!blocking.ip}>
            复制
          </Button>
        </div>
        {blocking.apis.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            被拒接口：{blocking.apis.join(" / ")}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={onRetry} disabled={retrying}>
            {retrying && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            已完成，重试
          </Button>
        </div>
      </div>
    );
  }
  if (blocking.kind === "no_api") {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm space-y-2">
        <div className="font-medium">当前授权无以下接口权限</div>
        <ul className="text-xs text-muted-foreground list-disc pl-5">
          {blocking.apis.map((a) => (
            <li key={a} className="font-mono">{a}</li>
          ))}
        </ul>
        <div className="text-[11px] text-muted-foreground">
          若店铺不是零售版，`retail.*` 接口本身无法授权；请在有赞应用中心确认已勾选「商品类目」相关接口。
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <div className="font-medium text-destructive mb-1">拉取失败</div>
      <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-all">{blocking.message}</pre>
    </div>
  );
}
