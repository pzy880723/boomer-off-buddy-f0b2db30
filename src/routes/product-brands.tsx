import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, Pencil, Plus, Search, Trash2 } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteBrand,
  listBrands,
  upsertBrand,
  type BrandInputValue,
  type BrandRow,
} from "@/lib/product-taxonomy.functions";

export const Route = createFileRoute("/product-brands")({
  head: () => ({
    meta: [
      { title: "品牌库 · BOOMER OFF" },
      { name: "description", content: "中古商品品牌、制造商、窑口与别名维护" },
    ],
  }),
  component: ProductBrandsPage,
});

const entityLabels: Record<BrandRow["entity_type"], string> = {
  brand: "品牌",
  manufacturer: "制造商",
  kiln: "窑口",
  studio: "工作室",
  designer: "设计师",
};

function ProductBrandsPage() {
  const queryClient = useQueryClient();
  const list = useServerFn(listBrands);
  const save = useServerFn(upsertBrand);
  const remove = useServerFn(deleteBrand);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | BrandRow["status"]>("all");
  const [editing, setEditing] = useState<BrandRow | null | "new">(null);

  const query = useQuery({
    queryKey: ["inv-brands", status],
    queryFn: () => list({ data: status === "all" ? {} : { status } }),
  });
  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return query.data?.rows ?? [];
    return (query.data?.rows ?? []).filter((row) =>
      [row.name, row.name_original, row.origin_country, ...row.aliases]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [query.data?.rows, search]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => {
      toast.success("品牌已删除");
      queryClient.invalidateQueries({ queryKey: ["inv-brands"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "删除失败"),
  });

  return (
    <div>
      <PageHeader
        title="品牌库"
        description="统一维护品牌、制造商、窑口与别名。AI 只能匹配品牌库，不会自动创建正式品牌。"
        meta={
          <span>
            共 {query.data?.rows.length ?? 0} 条 · 当前显示 {rows.length} 条
          </span>
        }
        actions={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> 新建品牌
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索名称、原文、别名或国家"
            className="h-9 pl-8"
          />
        </div>
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
          <SelectTrigger className="h-9 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">启用</SelectItem>
            <SelectItem value="review">待审核</SelectItem>
            <SelectItem value="inactive">停用</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>品牌/机构</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>别名</TableHead>
              <TableHead>产地</TableHead>
              <TableHead>适用分类</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-24 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">
                  正在加载品牌库…
                </TableCell>
              </TableRow>
            )}
            {!query.isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">
                  没有符合条件的品牌
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded border bg-muted/40">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium">{row.name}</div>
                      {row.name_original && (
                        <div className="text-xs text-muted-foreground">{row.name_original}</div>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>{entityLabels[row.entity_type]}</TableCell>
                <TableCell className="max-w-72">
                  <div className="flex flex-wrap gap-1">
                    {row.aliases.slice(0, 4).map((alias) => (
                      <Badge key={alias} variant="outline" className="font-normal">
                        {alias}
                      </Badge>
                    ))}
                    {row.aliases.length > 4 && (
                      <span className="text-xs text-muted-foreground">
                        +{row.aliases.length - 4}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {[row.origin_country, row.origin_region].filter(Boolean).join(" · ") || "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.category_codes.length ? row.category_codes.join("、") : "全部"}
                </TableCell>
                <TableCell>
                  <Badge variant={row.status === "active" ? "default" : "outline"}>
                    {row.status === "active" ? "启用" : row.status === "review" ? "待审核" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="编辑品牌"
                    onClick={() => setEditing(row)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="删除品牌"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (confirm(`删除品牌「${row.name}」？`)) deleteMutation.mutate(row.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <BrandDialog
        value={editing === "new" ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={async (payload) => {
          await save({ data: payload });
          toast.success("品牌已保存");
          setEditing(null);
          queryClient.invalidateQueries({ queryKey: ["inv-brands"] });
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

function BrandDialog({
  value,
  open,
  onOpenChange,
  onSave,
}: {
  value: BrandRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (payload: BrandInputValue) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const key = value?.id ?? "new";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent key={key} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{value ? "编辑品牌" : "新建品牌"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            setSaving(true);
            try {
              await onSave({
                ...(value ? { id: value.id } : {}),
                name: String(data.get("name") ?? ""),
                name_original: String(data.get("name_original") ?? "") || null,
                aliases: splitList(String(data.get("aliases") ?? "")),
                entity_type: String(data.get("entity_type") ?? "brand") as BrandRow["entity_type"],
                origin_country: String(data.get("origin_country") ?? "") || null,
                origin_region: String(data.get("origin_region") ?? "") || null,
                category_codes: splitList(String(data.get("category_codes") ?? "")),
                logo_url: String(data.get("logo_url") ?? "") || null,
                status: String(data.get("status") ?? "active") as BrandRow["status"],
                notes: String(data.get("notes") ?? "") || null,
              });
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "保存失败");
            } finally {
              setSaving(false);
            }
          }}
        >
          <Field label="标准名称" name="name" defaultValue={value?.name} required />
          <Field label="原文名称" name="name_original" defaultValue={value?.name_original} />
          <div className="space-y-2">
            <Label htmlFor="entity_type">实体类型</Label>
            <select
              id="entity_type"
              name="entity_type"
              defaultValue={value?.entity_type ?? "brand"}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              {Object.entries(entityLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="status">状态</Label>
            <select
              id="status"
              name="status"
              defaultValue={value?.status ?? "active"}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="active">启用</option>
              <option value="review">待审核</option>
              <option value="inactive">停用</option>
            </select>
          </div>
          <Field label="国家" name="origin_country" defaultValue={value?.origin_country} />
          <Field label="地区" name="origin_region" defaultValue={value?.origin_region} />
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="aliases">别名</Label>
            <Input
              id="aliases"
              name="aliases"
              defaultValue={value?.aliases.join("，")}
              placeholder="则武，日本陶器会社"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="category_codes">适用主分类编码</Label>
            <Input
              id="category_codes"
              name="category_codes"
              defaultValue={value?.category_codes.join("，")}
              placeholder="留空表示全部分类"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="logo_url">Logo URL</Label>
            <Input
              id="logo_url"
              name="logo_url"
              defaultValue={value?.logo_url ?? ""}
              placeholder="https://…"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="notes">备注</Label>
            <Textarea id="notes" name="notes" defaultValue={value?.notes ?? ""} rows={3} />
          </div>
          <DialogFooter className="sm:col-span-2">
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

function Field({
  label,
  name,
  defaultValue,
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  required?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaultValue ?? ""} required={required} />
    </div>
  );
}
