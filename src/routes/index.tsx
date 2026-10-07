import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "BOOMER OFF ERP · 工作入口" },
    { name: "description", content: "BOOMER OFF ERP 门店与商品工作入口。" },
    { property: "og:title", content: "BOOMER OFF ERP · 工作入口" },
    { property: "og:description", content: "BOOMER OFF ERP 门店与商品工作入口。" },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});
