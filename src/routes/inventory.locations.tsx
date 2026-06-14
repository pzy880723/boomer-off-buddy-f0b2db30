import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listLocations, toggleLocationActive } from "@/lib/locations.functions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/inventory/locations")({
  component: LocationsPage,
});

function LocationsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listLocations);
  const toggle = useServerFn(toggleLocationActive);
  const q = useQuery({ queryKey: ["inv-locations"], queryFn: () => list() });

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">库位管理</h1>
        <p className="text-sm text-muted-foreground">
          仓库 + 有赞门店映射；手持终端按位置上报库存。
        </p>
      </div>
      <div className="rounded-md border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>类型</TableHead>
              <TableHead>名称</TableHead>
              <TableHead>关联门店</TableHead>
              <TableHead>备注</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data ?? []).map((l: any) => (
              <TableRow key={l.id}>
                <TableCell>
                  <Badge variant={l.kind === "warehouse" ? "default" : "secondary"}>
                    {l.kind === "warehouse" ? "仓库" : "门店"}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium">{l.name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {l.shop?.shop_name ?? "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {l.notes ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant={l.is_active ? "default" : "outline"}>
                    {l.is_active ? "启用" : "停用"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      await toggle({ data: { id: l.id, is_active: !l.is_active } });
                      toast.success("已更新");
                      qc.invalidateQueries({ queryKey: ["inv-locations"] });
                    }}
                  >
                    {l.is_active ? "停用" : "启用"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
