import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Search, Tag } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listBrands,
  upsertBrand,
  deleteBrand,
  setBrandStatus,
  type BrandRow,
} from "@/lib/brands.functions";

export const Route = createFileRoute("/product-brands")({
  head: () => ({
    meta: [
      { title: "品牌 / 窑口 / IP · BOOMER OFF" },
      {
        name: "description",
        content: "维护品牌、窑口、动漫 IP 及其别名，供 SKU 智能识别与搜索使用。",
      },
    ],
  }),
  component: ProductBrandsPage,
});

const ENTITY_LABEL: Record<BrandRow["entity_type"], string> = {
  brand: "品牌",
  manufacturer: "品牌",
  kiln: "窑口",
  studio: "IP",
  designer: "品牌",
  ip: "IP",
};

// UI 可选类型（编辑弹窗下拉）
const EDITABLE_TYPES: { value: BrandRow["entity_type"]; label: string }[] = [
  { value: "brand", label: "品牌" },
  { value: "kiln", label: "窑口" },
  { value: "ip", label: "IP（动漫）" },
];

type TabKey = "all" | "brand" | "kiln" | "ip";

function bucketOf(t: BrandRow["entity_type"]): "brand" | "kiln" | "ip" {
  if (t === "kiln") return "kiln";
  if (t === "ip" || t === "studio") return "ip";
  return "brand"; // brand / manufacturer / designer
}

const STATUS_LABEL: Record<BrandRow["status"], string> = {
  active: "启用",
  inactive: "停用",
  review: "待审核",
};

function ProductBrandsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listBrands);
  const upsert = useServerFn(upsertBrand);
  const del = useServerFn(deleteBrand);
  const setStatus = useServerFn(setBrandStatus);

  const q = useQuery({ queryKey: ["inv-brands"], queryFn: () => list() });
  const rows: BrandRow[] = q.data?.rows ?? [];

  const [keyword, setKeyword] = useState("");
  const [tab, setTab] = useState<TabKey>("all");
  const [editing, setEditing] = useState<BrandRow | null>(null);
  const [creating, setCreating] = useState(false);

  const counts = useMemo(() => {
    const c = { all: rows.length, brand: 0, kiln: 0, ip: 0 };
    for (const r of rows) c[bucketOf(r.entity_type)] += 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== "all" && bucketOf(r.entity_type) !== tab) return false;
      if (!k) return true;
      if (r.name.toLowerCase().includes(k)) return true;
      if (r.name_original?.toLowerCase().includes(k)) return true;
      if (r.normalized_name.includes(k)) return true;
      if (r.aliases.some((a) => a.toLowerCase().includes(k))) return true;
      if (r.origin_country?.toLowerCase().includes(k)) return true;
      return false;
    });
  }, [rows, keyword, tab]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["inv-brands"] });

  const deleteMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "删除失败"),
  });

  const statusMut = useMutation({
    mutationFn: (r: BrandRow) =>
      setStatus({
        data: { id: r.id, status: r.status === "active" ? "inactive" : "active" },
      }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "操作失败"),
  });

  const activeCount = rows.filter((r) => r.status === "active").length;
  const createDefaultType: BrandRow["entity_type"] =
    tab === "kiln" ? "kiln" : tab === "ip" ? "ip" : "brand";
  const createLabel =
    tab === "kiln" ? "新建窑口" : tab === "ip" ? "新建 IP" : "新建品牌";

  return (
    <div>
      <PageHeader
        title="品牌 / 窑口 / IP"
        description="维护品牌、窑口、动漫 IP 及其别名——用于 SKU 智能识别、多维筛选和搜索。"
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="mb-3">
        <TabsList>
          <TabsTrigger value="all">全部 <span className="ml-1 text-muted-foreground">{counts.all}</span></TabsTrigger>
          <TabsTrigger value="brand">品牌 <span className="ml-1 text-muted-foreground">{counts.brand}</span></TabsTrigger>
          <TabsTrigger value="kiln">窑口 <span className="ml-1 text-muted-foreground">{counts.kiln}</span></TabsTrigger>
          <TabsTrigger value="ip">IP（动漫） <span className="ml-1 text-muted-foreground">{counts.ip}</span></TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <Tag className="h-3 w-3" /> 共 {rows.length} 项 · 启用 {activeCount}
        </Badge>
        <div className="relative ml-auto w-64 max-w-full">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-7"
            placeholder="搜索名称、原名或别名…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> {createLabel}
        </Button>
      </div>


      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            {q.isLoading && (
              <div className="p-6 text-center text-sm text-muted-foreground">加载中…</div>
            )}
            {!q.isLoading && filtered.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {keyword ? "没有匹配的记录" : "暂无记录，点右上按钮新建"}
              </div>
            )}
            {filtered.map((r) => (
              <div
                key={r.id}
                className="flex items-start gap-3 px-3 py-2.5 text-sm hover:bg-muted/40"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={
                        r.status === "active"
                          ? "font-medium"
                          : "font-medium text-muted-foreground line-through"
                      }
                    >
                      {r.name}
                    </span>
                    {r.name_original && (
                      <span className="text-xs text-muted-foreground">
                        {r.name_original}
                      </span>
                    )}
                    <Badge variant="outline" className="text-[10px]">
                      {ENTITY_LABEL[r.entity_type]}
                    </Badge>
                    {r.origin_country && (
                      <Badge variant="secondary" className="text-[10px]">
                        {r.origin_country}
                        {r.origin_region ? ` · ${r.origin_region}` : ""}
                      </Badge>
                    )}
                    {r.status !== "active" && (
                      <Badge variant="outline" className="text-[10px]">
                        {STATUS_LABEL[r.status]}
                      </Badge>
                    )}
                  </div>
                  {r.aliases.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.aliases.map((a) => (
                        <span
                          key={a}
                          className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-0.5">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="编辑"
                    onClick={() => setEditing(r)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => statusMut.mutate(r)}
                  >
                    {r.status === "active" ? "停用" : "启用"}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive"
                    title="删除"
                    onClick={() => {
                      if (confirm(`删除「${r.name}」？`)) deleteMut.mutate(r.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <EditDialog
        open={creating || !!editing}
        onOpenChange={(v) => {
          if (!v) {
            setCreating(false);
            setEditing(null);
          }
        }}
        initial={editing}
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
    </div>
  );
}

type EditPayload = {
  id?: string;
  name: string;
  name_original: string | null;
  aliases: string[];
  entity_type: BrandRow["entity_type"];
  origin_country: string | null;
  origin_region: string | null;
  category_codes: string[];
  logo_url: string | null;
  status: BrandRow["status"];
  notes: string | null;
};

function EditDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: BrandRow | null;
  onSave: (p: EditPayload) => void;
}) {
  const [name, setName] = useState("");
  const [nameOriginal, setNameOriginal] = useState("");
  const [aliasesText, setAliasesText] = useState("");
  const [entityType, setEntityType] = useState<BrandRow["entity_type"]>("brand");
  const [country, setCountry] = useState("");
  const [region, setRegion] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [status, setStatus] = useState<BrandRow["status"]>("active");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setNameOriginal(initial?.name_original ?? "");
    setAliasesText((initial?.aliases ?? []).join(", "));
    setEntityType(initial?.entity_type ?? "brand");
    setCountry(initial?.origin_country ?? "");
    setRegion(initial?.origin_region ?? "");
    setLogoUrl(initial?.logo_url ?? "");
    setStatus(initial?.status ?? "active");
    setNotes(initial?.notes ?? "");
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "编辑品牌" : "新建品牌"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>名称 *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Noritake"
              />
            </div>
            <div className="space-y-1.5">
              <Label>原名 / 本地名</Label>
              <Input
                value={nameOriginal}
                onChange={(e) => setNameOriginal(e.target.value)}
                placeholder="ノリタケ"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>别名（逗号分隔）</Label>
            <Input
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="则武, 日本陶器会社"
            />
            <p className="text-[11px] text-muted-foreground">
              用于 SKU 智能识别命中和搜索匹配
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>类型</Label>
              <Select
                value={entityType}
                onValueChange={(v) => setEntityType(v as BrandRow["entity_type"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ENTITY_LABEL) as BrandRow["entity_type"][]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {ENTITY_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>产地国家</Label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>产地地区</Label>
              <Input value={region} onChange={(e) => setRegion(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Logo URL</Label>
            <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>状态</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as BrandRow["status"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(STATUS_LABEL) as BrandRow["status"][]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {STATUS_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>备注</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => {
              const n = name.trim();
              if (!n) {
                toast.error("请填写名称");
                return;
              }
              const aliases = aliasesText
                .split(/[,，、\n]/)
                .map((s) => s.trim())
                .filter(Boolean);
              onSave({
                id: initial?.id,
                name: n,
                name_original: nameOriginal.trim() || null,
                aliases,
                entity_type: entityType,
                origin_country: country.trim() || null,
                origin_region: region.trim() || null,
                category_codes: initial?.category_codes ?? [],
                logo_url: logoUrl.trim() || null,
                status,
                notes: notes.trim() || null,
              });
            }}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
