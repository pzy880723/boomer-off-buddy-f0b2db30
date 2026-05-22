import { createFileRoute } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/orders/wholesale")({
  head: () => ({
    meta: [
      { title: "批发订单 · 订单管理" },
      { name: "description", content: "B 端批发出货订单" },
    ],
  }),
  component: WholesalePage,
});

function WholesalePage() {
  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <PageHeader title="批发订单" description="B 端批发 / 大客户出货订单" />
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <PackageCheck className="h-10 w-10 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">批发订单模块即将上线</p>
          <p className="text-xs text-muted-foreground/70">
            届时将支持 B 端批发开单、对账单导出、回款跟踪
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
