import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/stores/list")({
  beforeLoad: () => {
    throw redirect({ to: "/shop-mgmt/shops" });
  },
});
