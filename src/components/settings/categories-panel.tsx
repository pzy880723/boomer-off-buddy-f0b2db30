import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { RefreshCw, Plus, Trash2, PowerOff, Power, Link2, Loader2 } from "lucide-react";
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

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [rows],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base">商品分类</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            ERP 是分类的唯一真源。可从有赞总部拉取分类后手动采纳；停用后新建商品不再显示。
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={runPreview} disabled={syncing}>
            {syncing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            从有赞同步
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新建分类
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border divide-y">
          {q.isLoading && <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>}
          {!q.isLoading && sorted.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">暂无分类</div>
          )}
          {sorted.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={c.is_active ? "font-medium" : "font-medium text-muted-foreground line-through"}>
                    {c.name}
                  </span>
                  <Badge variant="outline" className="font-mono text-[10px]">{c.code}</Badge>
                  {c.is_system && <Badge variant="secondary" className="text-[10px]">系统</Badge>}
                  {c.youzan_hq_category_id && (
                    <Badge variant="outline" className="text-[10px] gap-1">
                      <Link2 className="h-3 w-3" /> 有赞 #{c.youzan_hq_category_id}
                    </Badge>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  排序 {c.sort_order}
                  {c.synced_at ? ` · 同步于 ${new Date(c.synced_at).toLocaleString("zh-CN")}` : ""}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => toggleActive.mutate(c)}>
                {c.is_active ? (
                  <><PowerOff className="mr-1 h-3.5 w-3.5" />停用</>
                ) : (
                  <><Power className="mr-1 h-3.5 w-3.5" />启用</>
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                编辑
              </Button>
              {!c.is_system && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    if (confirm(`确定删除分类「${c.name}」？`)) removeCat.mutate(c.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
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
        parents={rows.filter((r) => r.is_active && (!editing || r.id !== editing.id))}
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
            <DialogTitle>有赞分类同步预览</DialogTitle>
            <DialogDescription>
              {previewData
                ? `使用接口 ${previewData.api} · 待新增 ${previewData.to_add.length} · 待更新 ${previewData.to_update.length} · 待停用 ${previewData.to_deactivate.length}`
                : "加载中…"}
            </DialogDescription>
          </DialogHeader>
          {previewData && (
            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              <Section title={`新增（${previewData.to_add.length}）`}>
                {previewData.to_add.map((x) => (
                  <div key={x.yz.id} className="flex items-center gap-3 py-1 text-sm">
                    <Checkbox
                      checked={!!pickAdd[x.yz.id]}
                      onCheckedChange={(v) => setPickAdd((s) => ({ ...s, [x.yz.id]: !!v }))}
                    />
                    <span className="flex-1 truncate">{x.yz.name}</span>
                    <span className="text-[11px] text-muted-foreground">有赞 #{x.yz.id}</span>
                    <Input
                      className="h-7 w-28 font-mono text-xs"
                      value={codeOverride[x.yz.id] ?? x.suggest_code}
                      onChange={(e) =>
                        setCodeOverride((s) => ({ ...s, [x.yz.id]: e.target.value }))
                      }
                    />
                  </div>
                ))}
                {previewData.to_add.length === 0 && (
                  <p className="text-xs text-muted-foreground">无</p>
                )}
              </Section>
              <Section title={`更新名称（${previewData.to_update.length}）`}>
                {previewData.to_update.map((x) => (
                  <div key={x.local.id} className="flex items-center gap-3 py-1 text-sm">
                    <Checkbox
                      checked={!!pickUpd[x.local.id]}
                      onCheckedChange={(v) => setPickUpd((s) => ({ ...s, [x.local.id]: !!v }))}
                    />
                    <span className="flex-1 truncate">
                      <span className="text-muted-foreground line-through mr-2">{x.local.name}</span>
                      → <span className="font-medium">{x.yz.name}</span>
                    </span>
                    <Badge variant="outline" className="font-mono text-[10px]">{x.local.code}</Badge>
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
                      onCheckedChange={(v) => setPickDeact((s) => ({ ...s, [x.id]: !!v }))}
                    />
                    <span className="flex-1 truncate">{x.name}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">{x.code}</Badge>
                  </div>
                ))}
                {previewData.to_deactivate.length === 0 && (
                  <p className="text-xs text-muted-foreground">无</p>
                )}
              </Section>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSyncOpen(false)}>取消</Button>
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

  // reset when initial changes
  useState(() => {
    setCode(initial?.code ?? "");
    setName(initial?.name ?? "");
    setParent(initial?.parent_id ?? "");
    setSort(String(initial?.sort_order ?? 100));
    setActive(initial?.is_active ?? true);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (v) {
          setCode(initial?.code ?? "");
          setName(initial?.name ?? "");
          setParent(initial?.parent_id ?? "");
          setSort(String(initial?.sort_order ?? 100));
          setActive(initial?.is_active ?? true);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial ? "编辑分类" : "新建分类"}</DialogTitle>
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
              <Label>上级分类</Label>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
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
