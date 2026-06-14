import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  listDevices,
  createDevice,
  regenerateDeviceToken,
  setDeviceActive,
  updateDeviceLocation,
  listLocationsForDevices,
} from "@/lib/handheld-devices.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Copy, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/inventory/devices")({
  component: DevicesPage,
});

function DevicesPage() {
  const qc = useQueryClient();
  const list = useServerFn(listDevices);
  const locs = useServerFn(listLocationsForDevices);
  const create = useServerFn(createDevice);
  const regen = useServerFn(regenerateDeviceToken);
  const setActive = useServerFn(setDeviceActive);
  const setLoc = useServerFn(updateDeviceLocation);

  const devicesQ = useQuery({ queryKey: ["handheld-devices"], queryFn: () => list() });
  const locsQ = useQuery({ queryKey: ["handheld-locs"], queryFn: () => locs() });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ device_code: "", label: "", default_location_id: "" });

  const refresh = () => qc.invalidateQueries({ queryKey: ["handheld-devices"] });

  const createM = useMutation({
    mutationFn: () =>
      create({
        data: {
          device_code: form.device_code.trim(),
          label: form.label.trim(),
          default_location_id: form.default_location_id || null,
        },
      }),
    onSuccess: () => {
      toast.success("设备已创建");
      setOpen(false);
      setForm({ device_code: "", label: "", default_location_id: "" });
      refresh();
    },
    onError: (e: any) => toast.error(e.message),
  });

  const copy = (s: string) => {
    navigator.clipboard.writeText(s);
    toast.success("已复制");
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">手持终端管理</h1>
          <p className="text-sm text-muted-foreground">
            RFID 手持机用 <code>X-Device-Token</code> 调用 <code>/api/public/handheld/*</code>。
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>新增设备</Button>
      </div>

      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>设备编号</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>绑定位置</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>最后在线</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(devicesQ.data ?? []).map((d: any) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{d.device_code}</TableCell>
                <TableCell>{d.label}</TableCell>
                <TableCell>
                  <Select
                    value={d.default_location_id ?? "none"}
                    onValueChange={async (v) => {
                      await setLoc({
                        data: { id: d.id, default_location_id: v === "none" ? null : v },
                      });
                      toast.success("已更新");
                      refresh();
                    }}
                  >
                    <SelectTrigger className="h-8 w-[200px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">未绑定</SelectItem>
                      {(locsQ.data ?? []).map((l: any) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.kind === "warehouse" ? "[仓]" : "[店]"} {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  <div className="flex items-center gap-1">
                    <span className="truncate max-w-[140px]">{d.token.slice(0, 12)}…</span>
                    <Button size="icon" variant="ghost" onClick={() => copy(d.token)}>
                      <Copy className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm("重置后旧 token 立即失效")) return;
                        const { token } = await regen({ data: { id: d.id } });
                        copy(token);
                        toast.success("新 token 已生成并复制");
                        refresh();
                      }}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={d.is_active ? "default" : "secondary"}>
                    {d.is_active ? "启用" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await setActive({ data: { id: d.id, is_active: !d.is_active } });
                      refresh();
                    }}
                  >
                    {d.is_active ? "停用" : "启用"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {devicesQ.data && devicesQ.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                  暂无设备，点击右上角新增
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增手持终端</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>设备编号</Label>
              <Input
                value={form.device_code}
                onChange={(e) => setForm({ ...form, device_code: e.target.value })}
                placeholder="例如 HH-001"
              />
            </div>
            <div>
              <Label>名称</Label>
              <Input
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                placeholder="例如 总仓 1 号机"
              />
            </div>
            <div>
              <Label>默认绑定位置</Label>
              <Select
                value={form.default_location_id || "none"}
                onValueChange={(v) =>
                  setForm({ ...form, default_location_id: v === "none" ? "" : v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择位置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">暂不绑定</SelectItem>
                  {(locsQ.data ?? []).map((l: any) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.kind === "warehouse" ? "[仓]" : "[店]"} {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!form.device_code || !form.label || createM.isPending}
              onClick={() => createM.mutate()}
            >
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
