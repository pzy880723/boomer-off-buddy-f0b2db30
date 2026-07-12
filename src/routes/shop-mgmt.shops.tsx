import { createFileRoute } from "@tanstack/react-router";
import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, MapPin, User, Store, Pencil, ImagePlus, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { listShopsWithStats, updateShopMeta, createShop, syncSingleShop, type ShopWithStats } from "@/lib/shops.functions";
import { supabase } from "@/integrations/supabase/client";
import { compressImage } from "@/lib/image-upload";

export const Route = createFileRoute("/shop-mgmt/shops")({
  head: () => ({
    meta: [
      { title: "门店列表 · 门店管理" },
      { name: "description", content: "已授权有赞门店档案与本月销售概览" },
    ],
  }),
  component: ShopsPage,
});

function fmtMoney(n: number): string {
  if (n >= 10000) return `¥${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `¥${(n / 1000).toFixed(1)}k`;
  return `¥${n.toFixed(0)}`;
}

function roleLabel(role: string): string {
  if (role === "hq") return "总部";
  if (role === "branch") return "分店";
  return role;
}

function ShopsPage() {
  const list = useServerFn(listShopsWithStats);
  const q = useQuery({ queryKey: ["shops-with-stats"], queryFn: () => list() });
  const [editing, setEditing] = useState<ShopWithStats | null>(null);
  const [creating, setCreating] = useState(false);

  const shops = q.data ?? [];
  const hq = shops.filter((s) => s.role === "hq").length;
  const branch = shops.filter((s) => s.role === "branch").length;

  return (
    <div>
      <PageHeader
        title="门店列表"
        description="仅显示已授权同步的有赞门店"
        meta={
          <span>
            共 {shops.length} 家 · 总部 {hq} · 分店 {branch}
          </span>
        }
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            新增门店
          </Button>
        }
      />


      {q.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载中...
        </div>
      ) : shops.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            尚无已授权门店。请先在有赞后台完成 OAuth 授权。
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shops.map((s) => (
            <ShopCard key={s.id} shop={s} onEdit={() => setEditing(s)} />
          ))}
        </div>
      )}

      <EditShopDialog
        shop={editing}
        onClose={() => setEditing(null)}
      />
      <CreateShopDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ShopCard({ shop, onEdit }: { shop: ShopWithStats; onEdit: () => void }) {
  const qc = useQueryClient();
  const syncFn = useServerFn(syncSingleShop);
  const syncM = useMutation({
    mutationFn: () => syncFn({ data: { shop_id: shop.id, days: 30 } }),
    onSuccess: (r) => {
      const parts: string[] = [];
      parts.push(`商品 ${r.items.ok ? `✓ ${r.items.count}` : `✗ ${r.items.message}`}`);
      parts.push(`订单 ${r.orders.ok ? `✓ ${r.orders.count}` : `✗ ${r.orders.message}`}`);
      const allOk = r.items.ok && r.orders.ok;
      (allOk ? toast.success : toast.error)(`${shop.shop_name}：${parts.join(" · ")}`);
      qc.invalidateQueries({ queryKey: ["shops-with-stats"] });
    },
    onError: (e: Error) => toast.error(e.message || "同步失败"),
  });
  const canSync = !!shop.kdt_id && !!shop.access_token;
  const lastSync = shop.last_ping_at
    ? new Date(shop.last_ping_at).toLocaleString("zh-CN", { hour12: false })
    : null;
  return (
    <Card className="group overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
      <div className="relative h-36 overflow-hidden bg-muted">
        {shop.image_signed_url ? (
          <img
            src={shop.image_signed_url}
            alt={shop.shop_name}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-muted/40">
            <Store className="h-10 w-10 text-muted-foreground/50" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <div className="absolute left-3 top-3 flex gap-1.5">
          <StatusBadge tone={shop.role === "hq" ? "brand" : "info"}>
            {roleLabel(shop.role)}
          </StatusBadge>
          <StatusBadge tone={shop.ownership === "自营" ? "success" : "warning"}>
            {shop.ownership || "自营"}
          </StatusBadge>
          {shop.kdt_id ? (
            <StatusBadge tone={shop.access_token ? "success" : "neutral"}>
              {shop.access_token ? "已绑定" : "未绑定"}
            </StatusBadge>
          ) : null}
        </div>
        <div className="absolute right-3 top-3 flex gap-1.5">
          {canSync && (
            <button
              className="rounded-md bg-white/90 p-1.5 shadow-sm transition-colors hover:bg-white disabled:opacity-60"
              onClick={() => syncM.mutate()}
              disabled={syncM.isPending}
              title="从有赞同步商品与订单（近30天）"
            >
              {syncM.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            className="rounded-md bg-white/90 p-1.5 shadow-sm transition-colors hover:bg-white"
            onClick={onEdit}
            title="编辑门店"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="absolute bottom-3 left-3 right-3">
          <p className="text-base font-semibold text-white">{shop.shop_name}</p>
          <p className="mt-0.5 flex items-center gap-1 text-xs text-white/80">
            <MapPin className="h-3 w-3" />
            {shop.address || "未填写地址"}
          </p>
        </div>
      </div>
      <CardContent className="p-4">
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-[10px] text-muted-foreground">本月营业额</p>
            <p className="mt-0.5 font-semibold tabular-nums text-primary">
              {fmtMoney(shop.revenue_month)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">本月订单</p>
            <p className="mt-0.5 font-semibold tabular-nums">{shop.order_count_month}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">在售商品</p>
            <p className="mt-0.5 font-semibold tabular-nums">
              {shop.item_count}
              <span className="ml-1 text-xs text-muted-foreground">
                / 库存 {shop.stock_total}
              </span>
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            {shop.manager ? `店长 · ${shop.manager}` : "未填写店长"}
          </span>
          <span className="tabular-nums">kdt {shop.kdt_id}</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                shop.last_ping_ok === true
                  ? "bg-emerald-500"
                  : shop.last_ping_ok === false
                    ? "bg-rose-500"
                    : "bg-muted-foreground/40"
              }`}
            />
            {lastSync ? `最近同步 ${lastSync}` : "尚未同步"}
          </span>
          {canSync ? (
            <button
              className="text-primary hover:underline disabled:opacity-60"
              onClick={() => syncM.mutate()}
              disabled={syncM.isPending}
            >
              {syncM.isPending ? "同步中…" : "立即同步"}
            </button>
          ) : (
            <span className="text-muted-foreground/70">未绑定有赞</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}


function EditShopDialog({
  shop,
  onClose,
}: {
  shop: ShopWithStats | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updateShopMeta);
  const [form, setForm] = useState<{
    address: string;
    manager: string;
    area_sqm: string;
    opened_at: string;
    phone: string;
    notes: string;
    image_url: string | null;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // sync when shop changes
  if (shop && (form === null || (form as { _id?: string })._id !== shop.id)) {
    setForm({
      address: shop.address ?? "",
      manager: shop.manager ?? "",
      area_sqm: shop.area_sqm != null ? String(shop.area_sqm) : "",
      opened_at: shop.opened_at ?? "",
      phone: shop.phone ?? "",
      notes: shop.notes ?? "",
      image_url: shop.image_url,
      // @ts-expect-error stash id for change detection
      _id: shop.id,
    });
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!shop || !form) return;
      await update({
        data: {
          id: shop.id,
          address: form.address || null,
          manager: form.manager || null,
          area_sqm: form.area_sqm ? Number(form.area_sqm) : null,
          opened_at: form.opened_at || null,
          phone: form.phone || null,
          notes: form.notes || null,
          image_url: form.image_url,
        },
      });
    },
    onSuccess: () => {
      toast.success("已保存");
      qc.invalidateQueries({ queryKey: ["shops-with-stats"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message || "保存失败"),
  });

  async function handleUpload(file: File) {
    if (!shop) return;
    setUploading(true);
    try {
      const { blob, ext, mime } = await compressImage(file, file.name);
      const path = `${shop.id}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from("shop-images")
        .upload(path, blob, { contentType: mime, upsert: true });
      if (error) throw new Error(error.message);
      // delete previous (best-effort)
      if (form?.image_url && form.image_url !== path) {
        await supabase.storage.from("shop-images").remove([form.image_url]).catch(() => {});
      }
      setForm((f) => (f ? { ...f, image_url: path } : f));
      toast.success("图片已上传，别忘了点保存");
    } catch (e) {
      toast.error((e as Error).message || "上传失败");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={!!shop} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑门店 · {shop?.shop_name}</DialogTitle>
        </DialogHeader>
        {form && shop && (
          <div className="space-y-4">
            <div>
              <Label className="mb-1.5 block text-xs">封面图</Label>
              <div className="flex items-center gap-3">
                <div className="h-20 w-32 overflow-hidden rounded-md border bg-muted">
                  {form.image_url ? (
                    <ImagePreview path={form.image_url} />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <Store className="h-6 w-6" />
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={uploading}
                    onClick={() => fileRef.current?.click()}
                  >
                    {uploading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {form.image_url ? "更换图片" : "上传图片"}
                  </Button>
                  {form.image_url && (
                    <button
                      className="text-left text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => setForm({ ...form, image_url: null })}
                    >
                      移除
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label className="mb-1.5 block text-xs">地址</Label>
                <Input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="上海市黄浦区…"
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">店长</Label>
                <Input
                  value={form.manager}
                  onChange={(e) => setForm({ ...form, manager: e.target.value })}
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">联系电话</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">面积 (㎡)</Label>
                <Input
                  type="number"
                  value={form.area_sqm}
                  onChange={(e) => setForm({ ...form, area_sqm: e.target.value })}
                />
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">开业日期</Label>
                <Input
                  type="date"
                  value={form.opened_at}
                  onChange={(e) => setForm({ ...form, opened_at: e.target.value })}
                />
              </div>
              <div className="col-span-2">
                <Label className="mb-1.5 block text-xs">备注</Label>
                <Textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImagePreview({ path }: { path: string }) {
  const q = useQuery({
    queryKey: ["shop-image-signed", path],
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("shop-images")
        .createSignedUrl(path, 3600);
      return data?.signedUrl ?? null;
    },
  });
  if (!q.data) return <div className="h-full w-full animate-pulse bg-muted" />;
  return <img src={q.data} alt="" className="h-full w-full object-cover" />;
}

function CreateShopDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const create = useServerFn(createShop);
  const [form, setForm] = useState({
    shop_name: "",
    ownership: "自营" as "自营" | "加盟",
    kdt_id: "",
    address: "",
    manager: "",
    phone: "",
  });

  const m = useMutation({
    mutationFn: async () => {
      if (!form.shop_name.trim()) throw new Error("请填写门店名称");
      const kdt = form.kdt_id.trim();
      return await create({
        data: {
          shop_name: form.shop_name.trim(),
          ownership: form.ownership,
          kdt_id: kdt ? Number(kdt) : null,
          address: form.address || null,
          manager: form.manager || null,
          phone: form.phone || null,
        },
      });
    },
    onSuccess: (r) => {
      toast.success(r.bound ? "已创建并成功绑定有赞店铺" : "已创建门店（未绑定有赞）");
      qc.invalidateQueries({ queryKey: ["shops-with-stats"] });
      setForm({
        shop_name: "",
        ownership: "自营",
        kdt_id: "",
        address: "",
        manager: "",
        phone: "",
      });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message || "创建失败"),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新增门店</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="mb-1.5 block text-xs">门店名称 *</Label>
            <Input
              value={form.shop_name}
              onChange={(e) => setForm({ ...form, shop_name: e.target.value })}
              placeholder="例如：BOOMER OFF vintage（中信泰富店）"
            />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">经营类型 *</Label>
            <div className="flex gap-2">
              {(["自营", "加盟"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setForm({ ...form, ownership: v })}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    form.ownership === v
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs">
              有赞店铺 ID (kdt_id)
              <span className="ml-1 text-muted-foreground">— 留空表示暂不对接有赞</span>
            </Label>
            <Input
              value={form.kdt_id}
              onChange={(e) => setForm({ ...form, kdt_id: e.target.value.replace(/\D/g, "") })}
              placeholder="填入有赞后台的 kdt_id"
              inputMode="numeric"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              填入后系统会自动通过 API 尝试授权，成功即显示「已绑定」。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="mb-1.5 block text-xs">地址</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs">店长</Label>
              <Input
                value={form.manager}
                onChange={(e) => setForm({ ...form, manager: e.target.value })}
              />
            </div>
            <div>
              <Label className="mb-1.5 block text-xs">联系电话</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
