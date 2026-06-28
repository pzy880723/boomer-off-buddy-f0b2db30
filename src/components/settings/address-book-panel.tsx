import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Star, Trash2, Pencil, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listAddresses,
  upsertAddress,
  deleteAddress,
  setDefaultAddress,
  type OrgAddress,
} from "@/lib/addresses.functions";

export function AddressBookPanel() {
  const qc = useQueryClient();
  const listFn = useServerFn(listAddresses);
  const upsertFn = useServerFn(upsertAddress);
  const delFn = useServerFn(deleteAddress);
  const defFn = useServerFn(setDefaultAddress);

  const { data = [], isLoading } = useQuery({
    queryKey: ["org-addresses"],
    queryFn: () => listFn(),
  });

  const [editing, setEditing] = useState<Partial<OrgAddress> | null>(null);

  const saveMut = useMutation({
    mutationFn: (v: Partial<OrgAddress>) =>
      upsertFn({
        data: {
          id: v.id ?? null,
          label: v.label ?? "",
          receiver_name: v.receiver_name ?? null,
          receiver_phone: v.receiver_phone ?? null,
          address: v.address ?? "",
          is_default: v.is_default ?? false,
        },
      }),
    onSuccess: () => {
      toast.success("已保存");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["org-addresses"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["org-addresses"] });
    },
  });

  const defMut = useMutation({
    mutationFn: (id: string) => defFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["org-addresses"] }),
  });

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">地址库</h3>
            <p className="text-xs text-muted-foreground">用于国内大宗等采购单据的收货地址默认带入</p>
          </div>
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus className="mr-1 h-3.5 w-3.5" /> 新增地址
          </Button>
        </div>

        {isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto h-4 w-4 animate-spin" />
          </div>
        ) : data.length === 0 ? (
          <p className="rounded border border-dashed py-8 text-center text-xs text-muted-foreground">
            暂无地址，点击「新增地址」添加常用收货地址
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {data.map((a) => (
              <div key={a.id} className="rounded-md border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-medium">
                    {a.label}
                    {a.is_default && (
                      <Badge variant="secondary" className="ml-2 text-[10px]">
                        默认
                      </Badge>
                    )}
                  </div>
                  <div className="flex gap-1">
                    {!a.is_default && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        title="设为默认"
                        onClick={() => defMut.mutate(a.id)}
                      >
                        <Star className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => setEditing(a)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive"
                      onClick={() => {
                        if (confirm(`删除地址「${a.label}」？`)) delMut.mutate(a.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {a.receiver_name ?? "—"} · {a.receiver_phone ?? "—"}
                </div>
                <div className="mt-1 text-xs">{a.address}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "编辑地址" : "新增地址"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <Field
                label="备注名 *"
                value={editing.label ?? ""}
                onChange={(v) => setEditing({ ...editing, label: v })}
                placeholder="如：公司前台 / 仓库"
              />
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="收件人"
                  value={editing.receiver_name ?? ""}
                  onChange={(v) => setEditing({ ...editing, receiver_name: v })}
                />
                <Field
                  label="联系电话"
                  value={editing.receiver_phone ?? ""}
                  onChange={(v) => setEditing({ ...editing, receiver_phone: v })}
                />
              </div>
              <Field
                label="详细地址 *"
                value={editing.address ?? ""}
                onChange={(v) => setEditing({ ...editing, address: v })}
              />
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={editing.is_default ?? false}
                  onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
                />
                设为默认地址
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              disabled={saveMut.isPending || !editing?.label || !editing?.address}
              onClick={() => editing && saveMut.mutate(editing)}
            >
              {saveMut.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 text-sm"
      />
    </div>
  );
}
