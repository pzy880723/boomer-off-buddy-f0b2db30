import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/shop-mgmt")({
  head: () => ({ meta: [{ title: "门店管理" }] }),
  component: () => <Outlet />,
});
