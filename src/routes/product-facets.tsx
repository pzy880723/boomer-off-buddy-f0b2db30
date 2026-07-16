import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Pencil, Plus, Tags } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listFacets,
  setFacetActive,
  upsertFacet,
  type FacetRow,
} from "@/lib/product-taxonomy.functions";
import { FACET_DIMENSIONS, type FacetDimension } from "@/lib/product-taxonomy";

export const Route = createFileRoute("/product-facets")({
  head: () => ({
    meta: [
      { title: "商品标签 · BOOMER OFF" },
      { name: "description", content: "商品多维标签、别名与适用分类维护" },
    ],
  }),
  component: ProductFacetsPage,
});

const dimensionLabels: Record<FacetDimension, string> = {
  object_type: "物件形态",
  function: "功能用途",
  origin: "产地",
  material: "材质",
  era: "年代",
  craft: "工艺",
  style: "风格",
  ip: "IP/作品",
  character: "角色",
  series: "系列",
  release_method: "发行方式",
};

function ProductFacetsPage() {
  const queryClient = useQueryClient();
  const list = useServerFn(listFacets);
  const toggle = useServerFn(setFacetActive);
  const [dimension, setDimension] = useState<"all" | FacetDimension>("all");
  const [editing, setEditing] = useState<FacetRow | null | "new">(null);
  const query = useQuery({
    queryKey: ["inv-facets", dimension],
    queryFn: () => list({ data: dimension === "all" ? {} : { dimension } }),
  });
  const rows = query.data?.rows ?? [];
  const toggleMutation = useMutation({
    mutationFn: (row: FacetRow) => toggle({ data: { id: row.id, is_active: !row.is_active } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inv-facets"] }),
    onError: (error) => toast.error(error instanceof Error ? error.message : "更新失败"),
  });

  return (
    <div>
      <PageHeader
        title="商品标签"
        description="主分类只选一个；这里维护可多选的产地、材质、年代、工艺、IP 等标签。"
        meta={
          <span>
            共 {rows.length} 个标签 · 启用 {rows.filter((row) => row.is_active).length}
          </span>
        }
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建标签
          </Button>
        }
      />

      <div className="mb-3 flex items-center gap-2">
        <Select
          value={dimension}
          onValueChange={(value) => setDimension(value as typeof dimension)}
        >
          <SelectTrigger className="h-9 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部维度</SelectItem>
            {FACET_DIMENSIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {dimensionLabels[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="outline" className="gap-1">
          <Tags className="h-3 w-3" /> 同维度可多选
        </Badge>
      </div>

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>维度</TableHead>
              <TableHead>标签</TableHead>
              <TableHead>编码</TableHead>
              <TableHead>别名</TableHead>
              <TableHead>适用主分类</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>启用</TableHead>
              <TableHead className="w-16 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="h-28 text-center text-muted-foreground">
                  正在加载标签…
                </TableCell>
              </TableRow>
            )}
            {!query.isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="h-28 text-center text-muted-foreground">
                  该维度暂无标签
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Badge variant="secondary">{dimensionLabels[row.dimension]}</Badge>
                </TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.code}
                </TableCell>
                <TableCell className="max-w-72 text-xs text-muted-foreground">
                  {row.aliases.join("、") || "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.category_codes.join("、") || "全部"}
                </TableCell>
                <TableCell>{row.is_system ? "系统" : "人工"}</TableCell>
                <TableCell>
                  <Switch
                    checked={row.is_active}
                    disabled={toggleMutation.isPending}
                    onCheckedChange={() => toggleMutation.mutate(row)}
                    aria-label={`${row.name}启用状态`}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="编辑标签"
                    onClick={() => setEditing(row)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <FacetDialog
        value={editing === "new" ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: ["inv-facets"] });
        }}
      />
    </div>
  );
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\n]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function FacetDialog({
  value,
  open,
  onOpenChange,
  onSaved,
}: {
  value: FacetRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const save = useServerFn(upsertFacet);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent key={value?.id ?? "new"} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{value ? "编辑标签" : "新建标签"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setSaving(true);
            try {
              await save({
                data: {
                  ...(value ? { id: value.id } : {}),
                  code: String(data.get("code") ?? ""),
                  name: String(data.get("name") ?? ""),
                  dimension: String(data.get("dimension") ?? "object_type") as FacetDimension,
                  aliases: splitList(String(data.get("aliases") ?? "")),
                  category_codes: splitList(String(data.get("category_codes") ?? "")),
                  sort_order: Number(data.get("sort_order") ?? 0),
                  is_active: data.get("is_active") === "on",
                },
              });
              toast.success("标签已保存");
              onSaved();
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "保存失败");
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="facet-name">标签名称</Label>
              <Input id="facet-name" name="name" defaultValue={value?.name ?? ""} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="facet-code">编码</Label>
              <Input
                id="facet-code"
                name="code"
                defaultValue={value?.code ?? ""}
                required
                disabled={value?.is_system}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="facet-dimension">维度</Label>
              <select
                id="facet-dimension"
                name="dimension"
                defaultValue={value?.dimension ?? "object_type"}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                {FACET_DIMENSIONS.map((item) => (
                  <option key={item} value={item}>
                    {dimensionLabels[item]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="facet-sort">排序</Label>
              <Input
                id="facet-sort"
                name="sort_order"
                type="number"
                min={0}
                max={9999}
                defaultValue={value?.sort_order ?? 0}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="facet-aliases">别名</Label>
            <Input
              id="facet-aliases"
              name="aliases"
              defaultValue={value?.aliases.join("，") ?? ""}
              placeholder="Japan，日本制"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="facet-categories">适用主分类编码</Label>
            <Input
              id="facet-categories"
              name="category_codes"
              defaultValue={value?.category_codes.join("，") ?? ""}
              placeholder="留空表示全部分类"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input name="is_active" type="checkbox" defaultChecked={value?.is_active ?? true} />{" "}
            启用标签
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
