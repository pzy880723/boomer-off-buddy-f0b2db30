import { createFileRoute } from "@tanstack/react-router";
import { Plus, MapPin, User, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { stores } from "@/lib/mock-data";

export const Route = createFileRoute("/shop-mgmt/shops")({
  head: () => ({
    meta: [
      { title: "门店列表 · 门店管理" },
      { name: "description", content: "管理直营与加盟门店档案" },
    ],
  }),
  component: ShopsPage,
});

function ShopsPage() {
  const direct = stores.filter((s) => s.type === "直营").length;
  const franchise = stores.filter((s) => s.type === "加盟").length;
  return (
    <div>
      <PageHeader
        title="门店列表"
        description="统一管理直营与加盟门店档案"
        meta={
          <span>
            共 {stores.length} 家门店 · 直营 {direct} · 加盟 {franchise}
          </span>
        }
        actions={
          <Button size="sm" className="bg-gradient-brand hover:opacity-90" onClick={() => toast.info("功能开发中")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            新增门店
          </Button>
        }
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {stores.map((s) => (
          <Card key={s.id} className="group overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
            <div className="relative h-36 overflow-hidden bg-muted">
              <img
                src={s.image}
                alt={s.name}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
              <div className="absolute left-3 top-3 flex gap-1.5">
                <StatusBadge tone={s.type === "直营" ? "brand" : "info"}>{s.type}</StatusBadge>
                <StatusBadge>{s.status}</StatusBadge>
              </div>
              <div className="absolute bottom-3 left-3 right-3">
                <p className="text-base font-semibold text-white">{s.name}</p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-white/80">
                  <MapPin className="h-3 w-3" />
                  {s.address}
                </p>
              </div>
            </div>
            <CardContent className="p-4">
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-[10px] text-muted-foreground">本月营收</p>
                  <p className="mt-0.5 font-semibold tabular-nums text-primary">
                    ¥{(s.monthRevenue / 1000).toFixed(1)}k
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">库存周转</p>
                  <p className="mt-0.5 font-semibold tabular-nums">{s.turnover.toFixed(1)}x</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">面积</p>
                  <p className="mt-0.5 font-semibold tabular-nums">
                    {s.area}
                    <span className="text-xs text-muted-foreground">㎡</span>
                  </p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <User className="h-3 w-3" />
                  店长 · {s.manager}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Maximize2 className="h-3 w-3" />
                  {s.youzanId}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
