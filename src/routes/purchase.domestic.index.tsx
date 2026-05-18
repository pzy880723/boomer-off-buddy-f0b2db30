import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { domesticOrders } from "@/lib/mock-data";

export const Route = createFileRoute("/purchase/domestic/")({
  head: () => ({ meta: [{ title: "国内渠道 · 采购物流" }, { name: "description", content: "国内电商平台采购订单聚合" }] }),
  component: DomesticPage,
});

const platformMeta: Record<string, { color: string; tag: string }> = {
  闲鱼: { color: "bg-amber-500", tag: "XY" },
  抖音: { color: "bg-neutral-900", tag: "DY" },
  小红书: { color: "bg-rose-500", tag: "XHS" },
  拼多多: { color: "bg-red-600", tag: "PDD" },
};

function DomesticPage() {
  const platforms = Object.keys(domesticOrders) as (keyof typeof domesticOrders)[];
  return (
    <div>
      <PageHeader
        title="国内渠道"
        description="自动抓取闲鱼、抖音、小红书、拼多多平台已购商品"
        actions={
          <Button size="sm" className="bg-gradient-brand hover:opacity-90" onClick={() => toast.success("已触发同步任务（模拟）")}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            手动同步
          </Button>
        }
      />
      <Tabs defaultValue={platforms[0]}>
        <TabsList>
          {platforms.map((p) => {
            const meta = platformMeta[p];
            return (
              <TabsTrigger key={p} value={p} className="gap-2">
                <span className={`flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold text-white ${meta.color}`}>
                  {meta.tag[0]}
                </span>
                {p}
                <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
                  {domesticOrders[p].length}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        {platforms.map((p) => (
          <TabsContent key={p} value={p} className="mt-4">
            <DataTable
              rowKey={(r) => r.id}
              data={domesticOrders[p]}
              columns={[
                { header: "订单号", cell: (r) => <span className="font-mono text-xs">{r.id}</span> },
                {
                  header: "商品标题",
                  cell: (r) => (
                    <div>
                      <div className="font-medium">{r.title}</div>
                      <div className="text-xs text-muted-foreground">卖家 · {r.seller}</div>
                    </div>
                  ),
                },
                { header: "实付金额", cell: (r) => <span className="font-semibold text-primary">¥{r.price}</span>, className: "tabular-nums text-right" },
                { header: "下单日期", cell: (r) => <span className="text-xs text-muted-foreground tabular-nums">{r.date}</span> },
                { header: "状态", cell: (r) => <StatusBadge>{r.status}</StatusBadge> },
                {
                  header: "操作",
                  cell: () => (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => toast.info("聊天截图功能开发中")}>
                      <MessageSquare className="mr-1 h-3 w-3" />
                      截图
                    </Button>
                  ),
                  className: "text-right",
                },
              ]}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
