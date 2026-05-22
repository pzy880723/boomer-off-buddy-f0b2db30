import { createFileRoute } from "@tanstack/react-router";
import { Plus, Wallet, CalendarClock, Store } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/page-header";
import { franchisees } from "@/lib/mock-data";

export const Route = createFileRoute("/shop-mgmt/franchisees")({
  head: () => ({ meta: [{ title: "加盟商管理 · 门店管理" }, { name: "description", content: "加盟商档案与开店进度" }] }),
  component: FranchiseesPage,
});

const milestones = ["签约", "选址", "材料发货", "装修施工", "验收开业"];

function FranchiseesPage() {
  return (
    <div>
      <PageHeader
        title="加盟商管理"
        description="加盟商档案、合同进度与装修甘特图"
        actions={
          <Button size="sm" className="bg-gradient-brand hover:opacity-90" onClick={() => toast.info("功能开发中")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            新增加盟商
          </Button>
        }
      />
      <div className="mb-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {franchisees.map((f) => (
          <Card key={f.id} className="transition-all hover:-translate-y-0.5 hover:shadow-card-hover">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12">
                  <AvatarFallback className="bg-gradient-brand text-base font-semibold text-primary-foreground">
                    {f.avatar}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-semibold">{f.name}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">{f.id}</p>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Store className="h-3 w-3" />
                    门店
                  </div>
                  <p className="mt-0.5 font-semibold tabular-nums">{f.stores}</p>
                </div>
                <div className="rounded-md bg-muted/50 p-2">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Wallet className="h-3 w-3" />
                    累计分账
                  </div>
                  <p className="mt-0.5 font-semibold tabular-nums text-primary">
                    ¥{(f.totalCommission / 1000).toFixed(0)}k
                  </p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                合同 {f.contractStart} ~ {f.contractEnd}
              </div>
              <div className="mt-3 space-y-2">
                <div>
                  <div className="mb-1 flex justify-between text-[11px]">
                    <span className="text-muted-foreground">物料配送</span>
                    <span className="tabular-nums">{f.materialProgress}%</span>
                  </div>
                  <Progress value={f.materialProgress} className="h-1.5" />
                </div>
                <div>
                  <div className="mb-1 flex justify-between text-[11px]">
                    <span className="text-muted-foreground">装修进度</span>
                    <span className="tabular-nums">{f.decorationProgress}%</span>
                  </div>
                  <Progress value={f.decorationProgress} className="h-1.5 [&>*]:bg-warning" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">装修进度甘特图</CardTitle>
          <p className="text-xs text-muted-foreground">从签约到开业的标准 5 阶段交付节点</p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="grid grid-cols-[120px_repeat(5,1fr)] gap-2 border-b pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <div>加盟商</div>
              {milestones.map((m) => (
                <div key={m} className="text-center">{m}</div>
              ))}
            </div>
            {franchisees.map((f) => {
              const progress = (f.materialProgress + f.decorationProgress) / 2;
              const completedSteps = Math.floor((progress / 100) * milestones.length);
              return (
                <div key={f.id} className="grid grid-cols-[120px_repeat(5,1fr)] gap-2 border-b py-3 last:border-0">
                  <div className="text-sm font-medium">{f.name}</div>
                  {milestones.map((_, i) => (
                    <div key={i} className="flex items-center">
                      <div
                        className={`h-2 w-full rounded-full ${
                          i < completedSteps
                            ? "bg-gradient-brand"
                            : i === completedSteps
                            ? "bg-warning/50"
                            : "bg-muted"
                        }`}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
