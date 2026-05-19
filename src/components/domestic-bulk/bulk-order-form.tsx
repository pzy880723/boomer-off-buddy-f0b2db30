import { useEffect, useState, useRef } from "react";
import { Plus, Trash2, Upload, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  BULK_STATUSES,
  BULK_STATUS_LABEL,
  type BulkStatus,
  type DomesticBulkOrderInput,
  type DomesticBulkLineInput,
} from "@/lib/domestic-bulk.functions";

export type BulkOrderFormValue = DomesticBulkOrderInput & {
  attachment_urls: string[];
};

export type BulkLineFormValue = DomesticBulkLineInput;

const EMPTY_ORDER: BulkOrderFormValue = {
  supplier_name: null,
  supplier_contact: null,
  source_order_no: null,
  purchased_at: null,
  total_cny: null,
  shipping_cny: null,
  status: "paid",
  carrier: null,
  tracking_no: null,
  receiver_name: null,
  receiver_phone: null,
  receiver_address: null,
  delivered_at: null,
  invoice_no: null,
  contract_no: null,
  pay_method: null,
  attachment_urls: [],
  notes: null,
};

const EMPTY_LINE: BulkLineFormValue = {
  position: 0,
  item_title: null,
  qty: 1,
  unit_price_cny: null,
  subtotal_cny: null,
  notes: null,
};

export function BulkOrderForm({
  initialOrder,
  initialLines,
  onChange,
}: {
  initialOrder?: Partial<BulkOrderFormValue>;
  initialLines?: BulkLineFormValue[];
  onChange: (order: BulkOrderFormValue, lines: BulkLineFormValue[]) => void;
}) {
  const [order, setOrder] = useState<BulkOrderFormValue>({
    ...EMPTY_ORDER,
    ...(initialOrder ?? {}),
    attachment_urls:
      (initialOrder?.attachment_urls as string[] | undefined) ?? EMPTY_ORDER.attachment_urls,
  });
  const [lines, setLines] = useState<BulkLineFormValue[]>(initialLines ?? []);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onChange(order, lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, lines]);

  const set = (k: keyof BulkOrderFormValue, v: unknown) =>
    setOrder((prev) => ({ ...prev, [k]: v as never }));

  const updateLine = (i: number, patch: Partial<BulkLineFormValue>) => {
    setLines((prev) => {
      const next = [...prev];
      const merged = { ...next[i], ...patch };
      // 自动算小计
      if (patch.qty !== undefined || patch.unit_price_cny !== undefined) {
        const qty = Number(merged.qty ?? 0);
        const unit = Number(merged.unit_price_cny ?? 0);
        if (qty > 0 && unit > 0) merged.subtotal_cny = Math.round(qty * unit * 100) / 100;
      }
      next[i] = merged;
      return next;
    });
  };

  const addLine = () =>
    setLines((prev) => [...prev, { ...EMPTY_LINE, position: prev.length }]);
  const removeLine = (i: number) =>
    setLines((prev) => prev.filter((_, idx) => idx !== i));

  const sumSubtotal = lines.reduce((s, l) => s + Number(l.subtotal_cny ?? 0), 0);

  const applySumToTotal = () => {
    const shipping = Number(order.shipping_cny ?? 0);
    set("total_cny", Math.round((sumSubtotal + shipping) * 100) / 100);
    toast.success("已根据明细回填总金额");
  };

  const uploadFiles = async (files: FileList) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const urls: string[] = [];
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop() ?? "bin";
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error } = await supabase.storage
          .from("domestic-bulk-attachments")
          .upload(path, file, { upsert: false });
        if (error) throw error;
        const { data } = supabase.storage.from("domestic-bulk-attachments").getPublicUrl(path);
        urls.push(data.publicUrl);
      }
      set("attachment_urls", [...(order.attachment_urls ?? []), ...urls]);
      toast.success(`已上传 ${urls.length} 个附件`);
    } catch (e) {
      toast.error("附件上传失败：" + (e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAttachment = (url: string) =>
    set(
      "attachment_urls",
      (order.attachment_urls ?? []).filter((u) => u !== url),
    );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {/* 基础信息 */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <h3 className="text-sm font-semibold">基础信息</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="供应商" value={order.supplier_name} onChange={(v) => set("supplier_name", v)} className="md:col-span-2" />
              <Field label="联系方式" value={order.supplier_contact} onChange={(v) => set("supplier_contact", v)} />
              <Field label="订单号" value={order.source_order_no} onChange={(v) => set("source_order_no", v)} />
              <Field label="采购时间" type="datetime-local" value={toLocalDt(order.purchased_at)} onChange={(v) => set("purchased_at", fromLocalDt(v))} />
              <Selector
                label="状态"
                value={order.status as string}
                onChange={(v) => set("status", v as BulkStatus)}
                options={BULK_STATUSES.map((s) => ({ value: s, label: BULK_STATUS_LABEL[s] }))}
              />
              <NumberField label="总金额 ¥" value={order.total_cny} onChange={(v) => set("total_cny", v)} />
              <NumberField label="运费 ¥" value={order.shipping_cny} onChange={(v) => set("shipping_cny", v)} />
              <Field label="付款方式" value={order.pay_method} onChange={(v) => set("pay_method", v)} placeholder="如：对公转账 / 支付宝" />
            </div>
          </CardContent>
        </Card>

        {/* 明细行 */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">商品明细 ({lines.length})</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tabular-nums">
                  小计合计：¥{sumSubtotal.toLocaleString("zh-CN")}
                </span>
                {sumSubtotal > 0 && (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={applySumToTotal}>
                    回填总金额
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-7" onClick={addLine}>
                  <Plus className="mr-1 h-3 w-3" /> 添加
                </Button>
              </div>
            </div>
            {lines.length === 0 ? (
              <p className="rounded border border-dashed py-6 text-center text-xs text-muted-foreground">
                暂无明细，点击「添加」录入商品行
              </p>
            ) : (
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-md border bg-muted/20 p-2">
                    <div className="col-span-5">
                      <Label className="text-[10px]">品名</Label>
                      <Input
                        value={l.item_title ?? ""}
                        onChange={(e) => updateLine(i, { item_title: e.target.value || null })}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px]">数量</Label>
                      <Input
                        type="number"
                        value={l.qty ?? ""}
                        onChange={(e) => updateLine(i, { qty: Number(e.target.value || 0) })}
                        className="h-8 text-xs tabular-nums"
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px]">单价 ¥</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={l.unit_price_cny ?? ""}
                        onChange={(e) =>
                          updateLine(i, {
                            unit_price_cny: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                        className="h-8 text-xs tabular-nums"
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-[10px]">小计 ¥</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={l.subtotal_cny ?? ""}
                        onChange={(e) =>
                          updateLine(i, {
                            subtotal_cny: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                        className="h-8 text-xs tabular-nums"
                      />
                    </div>
                    <div className="col-span-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-destructive"
                        onClick={() => removeLine(i)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 物流 */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <h3 className="text-sm font-semibold">物流信息</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="物流公司" value={order.carrier} onChange={(v) => set("carrier", v)} />
              <Field label="运单号" value={order.tracking_no} onChange={(v) => set("tracking_no", v)} />
              <Field label="签收时间" type="datetime-local" value={toLocalDt(order.delivered_at)} onChange={(v) => set("delivered_at", fromLocalDt(v))} />
              <Field label="收件人" value={order.receiver_name} onChange={(v) => set("receiver_name", v)} />
              <Field label="收件电话" value={order.receiver_phone} onChange={(v) => set("receiver_phone", v)} />
              <Field
                label="收件地址"
                value={order.receiver_address}
                onChange={(v) => set("receiver_address", v)}
                className="md:col-span-3"
              />
            </div>
          </CardContent>
        </Card>

        {/* 票据 */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <h3 className="text-sm font-semibold">票据 / 合同</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="发票号" value={order.invoice_no} onChange={(v) => set("invoice_no", v)} />
              <Field label="合同号" value={order.contract_no} onChange={(v) => set("contract_no", v)} />
            </div>
            <div>
              <Label className="text-xs">备注</Label>
              <Textarea
                rows={3}
                value={order.notes ?? ""}
                onChange={(e) => set("notes", e.target.value || null)}
                className="text-xs"
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 附件 */}
      <div>
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">附件 ({(order.attachment_urls ?? []).length})</h3>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Upload className="mr-1 h-3 w-3" />}
                上传
              </Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,.pdf"
                hidden
                onChange={(e) => e.target.files && uploadFiles(e.target.files)}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">支持合同/发票/付款截图，单文件 ≤ 25MB</p>
            {(order.attachment_urls ?? []).length === 0 ? (
              <p className="rounded border border-dashed py-6 text-center text-xs text-muted-foreground">
                暂无附件
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {(order.attachment_urls ?? []).map((url) => {
                  const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(url);
                  return (
                    <div key={url} className="group relative rounded border p-1">
                      {isImage ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          <img src={url} alt="" className="h-24 w-full rounded object-cover" />
                        </a>
                      ) : (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground hover:text-foreground"
                        >
                          📎 文件
                        </a>
                      )}
                      <button
                        type="button"
                        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground group-hover:flex"
                        onClick={() => removeAttachment(url)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  className,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  className?: string;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className={className}>
      <Label className="text-xs">{label}</Label>
      <Input
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 text-xs"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        step="0.01"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="h-8 text-xs tabular-nums"
      />
    </div>
  );
}

function Selector({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function toLocalDt(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDt(s: string | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
