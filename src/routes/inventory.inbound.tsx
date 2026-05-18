import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/inventory/inbound")({
  component: () => <Outlet />,
});
