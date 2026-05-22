import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/stores/franchisees")({
  beforeLoad: () => {
    throw redirect({ to: "/shop-mgmt/franchisees" });
  },
});
