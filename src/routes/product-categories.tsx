import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, ChevronDown, ChevronRight, FolderTree } from "lucide-react";
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
  type CategoryRow,
} from "@/lib/categories.functions";

export const Route = createFileRoute("/product-categories")({
  head: () => ({
    meta: [
      { title: "商品分类 · BOOMER OFF" },
      { name: "description", content: "ERP 商品一二级分类维护（唯一真源，与有赞无关）" },
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

  const erpQ = useQuery({ queryKey: ["inv-categories"], queryFn: () => list() });
  const rows = useMemo<CategoryRow[]>(() => erpQ.data?.rows ?? [], [erpQ.data?.rows]);

  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [creating, setCreating] = useState<{ parent_id: string | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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

  const invalidate = () => qc.invalidateQueries({ queryKey: ["inv-categories"] });

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

  const activeCount = rows.filter((r) => r.is_active).length;

  return (
    <div>
      <PageHeader
        title="商品分类"
        description="主分类只描述商品是什么，并保持一件商品只选一个叶子分类。产地、材质、年代、工艺、IP 等请使用商品标签。"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-muted/25 px-3 py-2 text-sm">
        <span className="text-muted-foreground">
          例：Noritake 咖啡杯的主分类是“瓷器与陶瓷 → 杯具与饮用器”，日本、骨瓷、昭和、描金是标签。
        </span>
        <Button asChild size="sm" variant="outline" className="ml-auto h-8">
          <Link to="/product-facets">管理商品标签</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className="h-8">
          <Link to="/product-brands">管理品牌库</Link>
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <FolderTree className="h-3 w-3" /> 共 {rows.length} 项 · 启用 {activeCount}
        </Badge>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreating({ parent_id: null })}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新建一级分类
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">ERP 分类</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border divide-y">
            {erpQ.isLoading && (
              <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>
            )}
            {!erpQ.isLoading && erpTree.roots.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                暂无分类，点右上「新建一级分类」
              </div>
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
                    onToggleOpen={() => setCollapsed((s) => ({ ...s, [r.id]: !collapsed[r.id] }))}
                    onEdit={() => setEditing(r)}
                    onAddChild={() => setCreating({ parent_id: r.id })}
                    onDelete={() => {
                      if (confirm(`删除分类「${r.name}」？`)) deleteMut.mutate(r.id);
                    }}
                    onToggleActive={() => toggleActiveMut.mutate(r)}
                  />
                  {open &&
                    kids.map((k) => (
                      <ErpRow
                        key={k.id}
                        row={k}
                        depth={1}
                        onEdit={() => setEditing(k)}
                        onDelete={() => {
                          if (confirm(`删除分类「${k.name}」？`)) deleteMut.mutate(k.id);
                        }}
                        onToggleActive={() => toggleActiveMut.mutate(k)}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <EditDialog
        open={creating !== null || !!editing}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(null);
            setEditing(null);
          }
        }}
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
  onToggleOpen,
  onEdit,
  onAddChild,
  onDelete,
  onToggleActive,
}: {
  row: CategoryRow;
  depth: 0 | 1;
  hasChildren?: boolean;
  isOpen?: boolean;
  childCount?: number;
  onToggleOpen?: () => void;
  onEdit: () => void;
  onAddChild?: () => void;
  onDelete: () => void;
  onToggleActive: () => void;
}) {
  return (
    <div
      className={[
        "flex items-center gap-2 px-3 py-2 text-sm transition-colors",
        depth === 1 ? "bg-muted/20 pl-10" : "",
        "hover:bg-muted/40",
      ].join(" ")}
    >
      {depth === 0 ? (
        hasChildren ? (
          <button type="button" className="text-muted-foreground" onClick={() => onToggleOpen?.()}>
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
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={
              row.is_active ? "font-medium" : "font-medium text-muted-foreground line-through"
            }
          >
            {row.name}
          </span>
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.code}
          </Badge>
          {depth === 0 && childCount ? (
            <span className="text-[11px] text-muted-foreground">· {childCount} 个子级</span>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-0.5">
        {depth === 0 && onAddChild && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            title="添加子分类"
            onClick={onAddChild}
          >
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
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive"
            title="删除"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
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
  onSave: (p: {
    id?: string;
    code?: string;
    name: string;
    parent_id: string | null;
    sort_order: number;
    is_active: boolean;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string>("");
  const [sort, setSort] = useState<string>("100");
  const [active, setActive] = useState<boolean>(true);

  useEffect(() => {
    if (!open) return;
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
          <div className="space-y-1.5">
            <Label>名称 *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
            {!initial && (
              <p className="text-[11px] text-muted-foreground">
                短码由系统根据名称自动生成，无需手动填写
              </p>
            )}
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() =>
              onSave({
                id: initial?.id,
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
