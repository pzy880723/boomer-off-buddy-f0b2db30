import { createFileRoute } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const Route = createFileRoute("/shop-mgmt/online")({
  head: () => ({
    meta: [
      { title: "网店商品 · BOOMER OFF" },
      { name: "description", content: "网店商品统一管理（规划中）" },
    ],
  }),
  component: OnlineProductsPage,
});

function OnlineProductsPage() {
  return (
    <div>
      <PageHeader title="网店商品" description="独立电商网店的商品管理入口" />
      <EmptyState
        icon={Globe}
        title="网店模块规划中"
        description="待独立电商网店上线后，商品会在此统一维护、上下架与同步。"
      />
    </div>
  );
}
