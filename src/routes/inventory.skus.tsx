import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/inventory/skus")({
  component: () => <Outlet />,
});
