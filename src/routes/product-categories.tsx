import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Plus,
  RefreshCw,
  Loader2,
  Link2,
  Unlink,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  FolderTree,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listCategories,
  upsertCategory,
  deleteCategory,
  setCategoryActive,
  fetchYouzanGroupsLive,
  bindErpToYouzan,
  type CategoryRow,
  type YouzanGroupNode,
} from "@/lib/categories.functions";

export const Route = createFileRoute("/product-categories")({
  head: () => ({
    meta: [
      { title: "商品分类 · BOOMER OFF" },
      { name: "description", content: "ERP 商品一二级分类维护 + 与有赞店铺分组一一对应" },
    ],
  }),
  component: ProductCategoriesPage,
});

function ProductCategoriesPage() {
  const qc = useQueryClient();
  const list = useServerFn(listCategories);
  const upsert = useServerFn(upsertCategory);
  const del = useServerFn(deleteCategory);
  const setActive = useServerFn(setCategoryActive);
  const fetchYz = useServerFn(fetchYouzanGroupsLive);
  const bind = useServerFn(bindErpToYouzan);

  const erpQ = useQuery({ queryKey: ["inv-categories"], queryFn: () => list() });
  const yzQ = useQuery({
    queryKey: ["yz-groups-live"],
    queryFn: () => fetchYz(),
    staleTime: 60_000,
  });

  const rows: CategoryRow[] = erpQ.data?.rows ?? [];
  const yzRows: YouzanGroupNode[] = yzQ.data?.rows ?? [];
  const yzShopId = yzQ.data?.shop_id ?? null;

  const [selectedErpId, setSelectedErpId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [creating, setCreating] = useState<{ parent_id: string | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [yzCollapsed, setYzCollapsed] = useState<Record<number, boolean>>({});

  const selectedErp = useMemo(
    () => rows.find((r) => r.id === selectedErpId) ?? null,
    [rows, selectedErpId],
  );

  // ERP tree
  const erpTree = useMemo(() => {
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
    return { roots: byParent.get(null) ?? [], byParent };
  }, [rows]);

  // YZ tree
  const yzTree = useMemo(() => {
    const byParent = new Map<number | null, YouzanGroupNode[]>();
    for (const y of yzRows) {
      const pid = y.parent_id ?? null;
      const arr = byParent.get(pid) ?? [];
      arr.push(y);
      byParent.set(pid, arr);
    }
    const sortFn = (a: YouzanGroupNode, b: YouzanGroupNode) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
    for (const [, arr] of byParent) arr.sort(sortFn);
    return { roots: byParent.get(null) ?? [], byParent };
  }, [yzRows]);

  // Bindings
  const yzIdToErp = useMemo(() => {
    const m = new Map<number, CategoryRow>();
    for (const r of rows) if (r.youzan_hq_category_id) m.set(r.youzan_hq_category_id, r);
    return m;
  }, [rows]);
  const yzById = useMemo(() => {
    const m = new Map<number, YouzanGroupNode>();
    for (const y of yzRows) m.set(y.id, y);
    return m;
  }, [yzRows]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["inv-categories"] });

  const bindMut = useMutation({
    mutationFn: (v: { erp_id: string; yz: YouzanGroupNode | null }) =>
      bind({
        data: {
          erp_id: v.erp_id,
          youzan_group_id: v.yz?.id ?? null,
          youzan_parent_id: v.yz?.parent_id ?? null,
          youzan_shop_id: yzShopId,
        },
      }),
    onSuccess: () => {
      toast.success("绑定已更新");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "绑定失败"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "删除失败"),
  });

  const toggleActiveMut = useMutation({
    mutationFn: (r: CategoryRow) => setActive({ data: { id: r.id, is_active: !r.is_active } }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "操作失败"),
  });

  const onYzClick = (y: YouzanGroupNode) => {
    if (!selectedErp) {
      toast.info("请先在左侧选择一个 ERP 分类");
      return;
    }
    // 已被别的 ERP 占用：确认
    const occupied = yzIdToErp.get(y.id);
    if (occupied && occupied.id !== selectedErp.id) {
      if (!confirm(`「${y.name}」已绑定到「${occupied.name}」，是否改绑到「${selectedErp.name}」？`)) return;
    }
    // 同一行再点 = 解绑
    if (selectedErp.youzan_hq_category_id === y.id) {
      bindMut.mutate({ erp_id: selectedErp.id, yz: null });
      return;
    }
    bindMut.mutate({ erp_id: selectedErp.id, yz: y });
  };

  // Stats
  const boundCount = rows.filter((r) => r.youzan_hq_category_id).length;
  const unboundCount = rows.filter((r) => !r.youzan_hq_category_id && r.is_active).length;
  const yzOnlyCount = yzRows.filter((y) => !yzIdToErp.has(y.id)).length;

  return (
    <div>
      <PageHeader
        title="商品分类"
        description="左侧维护 ERP 自己的一二级分类（唯一真源），右侧展示有赞店铺分组，点击即可一一对应绑定"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <FolderTree className="h-3 w-3" /> ERP {rows.length} 项
        </Badge>
        <Badge variant="outline" className="text-emerald-600">已绑定 {boundCount}</Badge>
        <Badge variant="outline" className="text-amber-600">未绑定 {unboundCount}</Badge>
        <Badge variant="outline" className="text-muted-foreground">有赞独有 {yzOnlyCount}（忽略）</Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => qc.invalidateQueries({ queryKey: ["yz-groups-live"] })} disabled={yzQ.isFetching}>
            {yzQ.isFetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            从有赞刷新
          </Button>
          <Button size="sm" onClick={() => setCreating({ parent_id: null })}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新建一级分类
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* ERP 侧 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span>ERP 分类 · 可编辑</span>
              {selectedErp && (
                <span className="text-xs font-normal text-muted-foreground">
                  已选：{selectedErp.name}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border divide-y">
              {erpQ.isLoading && <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>}
              {!erpQ.isLoading && erpTree.roots.length === 0 && (
                <div className="p-6 text-center text-sm text-muted-foreground">暂无分类，点右上「新建一级分类」</div>
              )}
              {erpTree.roots.map((r) => {
                const kids = erpTree.byParent.get(r.id) ?? [];
                const open = !collapsed[r.id];
                return (
                  <div key={r.id}>
                    <ErpRow
                      row={r}
                      depth={0}
                      hasChildren={kids.length > 0}
                      isOpen={open}
                      childCount={kids.length}
                      selected={selectedErpId === r.id}
                      yzName={r.youzan_hq_category_id ? (yzById.get(r.youzan_hq_category_id)?.name ?? `#${r.youzan_hq_category_id}`) : null}
                      onSelect={() => setSelectedErpId(r.id)}
                      onToggleOpen={() => setCollapsed((s) => ({ ...s, [r.id]: !collapsed[r.id] }))}
                      onEdit={() => setEditing(r)}
                      onAddChild={() => setCreating({ parent_id: r.id })}
                      onDelete={() => { if (confirm(`删除分类「${r.name}」？`)) deleteMut.mutate(r.id); }}
                      onToggleActive={() => toggleActiveMut.mutate(r)}
                      onUnbind={() => bindMut.mutate({ erp_id: r.id, yz: null })}
                    />
                    {open && kids.map((k) => (
                      <ErpRow
                        key={k.id}
                        row={k}
                        depth={1}
                        selected={selectedErpId === k.id}
                        yzName={k.youzan_hq_category_id ? (yzById.get(k.youzan_hq_category_id)?.name ?? `#${k.youzan_hq_category_id}`) : null}
                        onSelect={() => setSelectedErpId(k.id)}
                        onEdit={() => setEditing(k)}
                        onDelete={() => { if (confirm(`删除分类「${k.name}」？`)) deleteMut.mutate(k.id); }}
                        onToggleActive={() => toggleActiveMut.mutate(k)}
                        onUnbind={() => bindMut.mutate({ erp_id: k.id, yz: null })}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* 有赞侧 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span>有赞店铺分组 · 只读</span>
              {yzQ.data?.api && (
                <span className="text-[10px] font-mono font-normal text-muted-foreground">{yzQ.data.api}</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {yzQ.data?.blocking && (
              <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <div className="font-medium text-destructive mb-1">拉取失败</div>
                {yzQ.data.blocking.kind === "ip_whitelist" && (
                  <div>请前往有赞云应用把 IP <code className="mx-1 rounded bg-muted px-1 font-mono">{yzQ.data.blocking.ip}</code> 加入白名单后重试。</div>
                )}
                {yzQ.data.blocking.kind === "no_api" && (
                  <div>当前授权无以下接口：{yzQ.data.blocking.apis.join(", ")}</div>
                )}
                {yzQ.data.blocking.kind === "other" && (
                  <pre className="whitespace-pre-wrap break-all text-muted-foreground">{yzQ.data.blocking.message}</pre>
                )}
              </div>
            )}
            <div className="rounded-md border divide-y">
              {yzQ.isLoading && <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>}
              {!yzQ.isLoading && yzTree.roots.length === 0 && !yzQ.data?.blocking && (
                <div className="p-6 text-center text-sm text-muted-foreground">未拉取到有赞分组</div>
              )}
              {yzTree.roots.map((y) => {
                const kids = yzTree.byParent.get(y.id) ?? [];
                const open = !yzCollapsed[y.id];
                return (
                  <div key={y.id}>
                    <YzRow
                      y={y}
                      depth={0}
                      hasChildren={kids.length > 0}
                      isOpen={open}
                      childCount={kids.length}
                      boundErp={yzIdToErp.get(y.id) ?? null}
                      selectedErpId={selectedErpId}
                      onToggleOpen={() => setYzCollapsed((s) => ({ ...s, [y.id]: !yzCollapsed[y.id] }))}
                      onClick={() => onYzClick(y)}
                    />
                    {open && kids.map((k) => (
                      <YzRow
                        key={k.id}
                        y={k}
                        depth={1}
                        boundErp={yzIdToErp.get(k.id) ?? null}
                        selectedErpId={selectedErpId}
                        onClick={() => onYzClick(k)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      <EditDialog
        open={creating !== null || !!editing}
        onOpenChange={(v) => { if (!v) { setCreating(null); setEditing(null); } }}
        initial={editing}
        defaultParentId={creating?.parent_id ?? null}
        parents={rows.filter((r) => r.parent_id === null && (!editing || r.id !== editing.id))}
        onSave={async (payload) => {
          try {
            await upsert({ data: payload });
            toast.success("已保存");
            invalidate();
            setCreating(null);
            setEditing(null);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "保存失败");
          }
        }}
      />
    </div>
  );
}

function ErpRow({
  row,
  depth,
  hasChildren,
  isOpen,
  childCount,
  selected,
  yzName,
  onSelect,
  onToggleOpen,
  onEdit,
  onAddChild,
  onDelete,
  onToggleActive,
  onUnbind,
}: {
  row: CategoryRow;
  depth: 0 | 1;
  hasChildren?: boolean;
  isOpen?: boolean;
  childCount?: number;
  selected: boolean;
  yzName: string | null;
  onSelect: () => void;
  onToggleOpen?: () => void;
  onEdit: () => void;
  onAddChild?: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
  onUnbind: () => void;
}) {
  return (
    <div
      className={[
        "flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors",
        depth === 1 ? "bg-muted/20 pl-10" : "",
        selected ? "bg-primary/10 ring-1 ring-inset ring-primary/40" : "hover:bg-muted/40",
      ].join(" ")}
      onClick={onSelect}
    >
      {depth === 0 ? (
        hasChildren ? (
          <button type="button" className="text-muted-foreground" onClick={(e) => { e.stopPropagation(); onToggleOpen?.(); }}>
            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : <span className="inline-block w-3.5" />
      ) : <span className="text-muted-foreground">└</span>}

      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={row.is_active ? "font-medium" : "font-medium text-muted-foreground line-through"}>{row.name}</span>
          <Badge variant="outline" className="font-mono text-[10px]">{row.code}</Badge>
          {yzName ? (
            <Badge variant="secondary" className="gap-1 text-[10px] bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
              <Link2 className="h-3 w-3" /> {yzName}
            </Badge>
          ) : row.is_active && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-300">未绑定</Badge>
          )}
          {depth === 0 && childCount ? (
            <span className="text-[11px] text-muted-foreground">· {childCount} 个子级</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        {row.youzan_hq_category_id && (
          <Button size="icon" variant="ghost" className="h-7 w-7" title="解绑" onClick={onUnbind}>
            <Unlink className="h-3.5 w-3.5" />
          </Button>
        )}
        {depth === 0 && onAddChild && (
          <Button size="icon" variant="ghost" className="h-7 w-7" title="添加子分类" onClick={onAddChild}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="h-7 w-7" title="编辑" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={onToggleActive}>
          {row.is_active ? "停用" : "启用"}
        </Button>
        {!row.is_system && (
          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="删除" onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function YzRow({
  y,
  depth,
  hasChildren,
  isOpen,
  childCount,
  boundErp,
  selectedErpId,
  onToggleOpen,
  onClick,
}: {
  y: YouzanGroupNode;
  depth: 0 | 1;
  hasChildren?: boolean;
  isOpen?: boolean;
  childCount?: number;
  boundErp: CategoryRow | null;
  selectedErpId: string | null;
  onToggleOpen?: () => void;
  onClick: () => void;
}) {
  const boundToSelected = boundErp && boundErp.id === selectedErpId;
  const boundToOther = boundErp && !boundToSelected;
  return (
    <div
      className={[
        "flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors",
        depth === 1 ? "bg-muted/20 pl-10" : "",
        boundToSelected ? "bg-emerald-50 ring-1 ring-inset ring-emerald-300" : "hover:bg-muted/40",
      ].join(" ")}
      onClick={onClick}
    >
      {depth === 0 ? (
        hasChildren ? (
          <button type="button" className="text-muted-foreground" onClick={(e) => { e.stopPropagation(); onToggleOpen?.(); }}>
            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : <span className="inline-block w-3.5" />
      ) : <span className="text-muted-foreground">└</span>}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{y.name}</span>
          <span className="text-[10px] font-mono text-muted-foreground">#{y.id}</span>
          {boundToSelected && (
            <Badge className="gap-1 text-[10px] bg-emerald-600 hover:bg-emerald-600">
              <Link2 className="h-3 w-3" /> 已绑定（再点解绑）
            </Badge>
          )}
          {boundToOther && (
            <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
              绑定至：{boundErp.name}
            </Badge>
          )}
          {depth === 0 && childCount ? (
            <span className="text-[11px] text-muted-foreground">· {childCount} 子级</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function EditDialog({
  open,
  onOpenChange,
  initial,
  defaultParentId,
  parents,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: CategoryRow | null;
  defaultParentId: string | null;
  parents: CategoryRow[];
  onSave: (p: { id?: string; code: string; name: string; parent_id: string | null; sort_order: number; is_active: boolean }) => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string>("");
  const [sort, setSort] = useState<string>("100");
  const [active, setActive] = useState<boolean>(true);

  useEffect(() => {
    if (!open) return;
    setCode(initial?.code ?? "");
    setName(initial?.name ?? "");
    setParent(initial?.parent_id ?? defaultParentId ?? "");
    setSort(String(initial?.sort_order ?? 100));
    setActive(initial?.is_active ?? true);
  }, [open, initial, defaultParentId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              <Input className="font-mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="如 CLOTHING" />
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
                  <option key={p.id} value={p.id}>{p.name}</option>
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
            onClick={() => onSave({
              id: initial?.id,
              code: code.trim(),
              name: name.trim(),
              parent_id: parent || null,
              sort_order: Number(sort) || 0,
              is_active: active,
            })}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
