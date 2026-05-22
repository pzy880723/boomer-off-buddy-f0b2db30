import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/orders")({
  head: () => ({
    meta: [
      { title: "订单管理" },
      { name: "description", content: "门店订单 / 铺货订单 / 批发订单 统一入口" },
    ],
  }),
  component: () => <Outlet />,
});
