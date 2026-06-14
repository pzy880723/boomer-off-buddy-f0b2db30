import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { listUnclaimed, claimEpc, discardUnclaimed } from "@/lib/unclaimed-epc.functions";
import { listLocationsForDevices } from "@/lib/handheld-devices.functions";
import { listSkus } from "@/lib/inventory.functions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export const Route = createFileRoute("/inventory/unclaimed")({
  component: UnclaimedPage,
});

function UnclaimedPage() {
  const qc = useQueryClient();
  const list = useServerFn(listUnclaimed);
  const claim = useServerFn(claimEpc);
  const discard = useServerFn(discardUnclaimed);
  const locsFn = useServerFn(listLocationsForDevices);
  const skusFn = useServerFn(listSkus);

  const q = useQuery({ queryKey: ["unclaimed"], queryFn: () => list() });
  const locsQ = useQuery({ queryKey: ["handheld-locs"], queryFn: () => locsFn() });

  const [target, setTarget] = useState<{ epc: string; last_loc: string | null } | null>(null);
  const [sel, setSel] = useState({ sku_id: "", location_id: "", q: "" });
  const skusQ = useQuery({
    queryKey: ["skus-search", sel.q],
    queryFn: () => skusFn({ data: { q: sel.q || undefined, limit: 30 } as any }),
    enabled: !!target,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["unclaimed"] });

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">待认领 EPC</h1>
        <p className="text-sm text-muted-foreground">
          手持机扫到的未识别 EPC，需手动指向 SKU 后入库。
        </p>
      </div>
      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>EPC</TableHead>
              <TableHead>最后扫描位置</TableHead>
              <TableHead>次数</TableHead>
              <TableHead>最后扫描</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data ?? []).map((u: any) => (
              <TableRow key={u.epc}>
                <TableCell className="font-mono text-xs">{u.epc}</TableCell>
                <TableCell>{u.location?.name ?? "—"}</TableCell>
                <TableCell>{u.hits}</TableCell>
                <TableCell className="text-xs">
                  {new Date(u.last_seen_at).toLocaleString()}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setTarget({ epc: u.epc, last_loc: u.last_seen_location_id });
                      setSel({
                        sku_id: "",
                        location_id: u.last_seen_location_id ?? "",
                        q: "",
                      });
                    }}
                  >
                    认领
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      if (!confirm("删除该 EPC？")) return;
                      await discard({ data: { epc: u.epc } });
                      refresh();
                    }}
                  >
                    丢弃
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {q.data && q.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">
                  暂无待认领 EPC
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>认领 EPC</DialogTitle>
          </DialogHeader>
          {target && (
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground">
                EPC: <span className="font-mono">{target.epc}</span>
              </div>
              <div>
                <div className="text-sm mb-1">选择库位</div>
                <Select
                  value={sel.location_id}
                  onValueChange={(v) => setSel({ ...sel, location_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择库位" />
                  </SelectTrigger>
                  <SelectContent>
                    {(locsQ.data ?? []).map((l: any) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.kind === "warehouse" ? "[仓]" : "[店]"} {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-sm mb-1">搜索 SKU</div>
                <Input
                  placeholder="按名称/编码搜索"
                  value={sel.q}
                  onChange={(e) => setSel({ ...sel, q: e.target.value })}
                />
                <div className="max-h-60 overflow-y-auto mt-2 border rounded divide-y">
                  {((skusQ.data as any)?.items ?? skusQ.data ?? []).map((s: any) => (
                    <button
                      type="button"
                      key={s.id}
                      onClick={() => setSel({ ...sel, sku_id: s.id })}
                      className={`w-full text-left px-2 py-1.5 text-sm hover:bg-accent ${
                        sel.sku_id === s.id ? "bg-accent" : ""
                      }`}
                    >
                      <span className="font-mono text-xs text-muted-foreground mr-2">
                        {s.sku_code}
                      </span>
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button
              disabled={!sel.sku_id || !sel.location_id}
              onClick={async () => {
                if (!target) return;
                await claim({
                  data: {
                    epc: target.epc,
                    sku_id: sel.sku_id,
                    location_id: sel.location_id,
                    apply_inbound: true,
                  },
                });
                toast.success("已认领并入库 +1");
                setTarget(null);
                refresh();
              }}
            >
              确认认领 + 入库 1 件
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
