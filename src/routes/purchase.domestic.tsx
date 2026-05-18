import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/purchase/domestic")({
  component: () => <Outlet />,
});
