import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/stores/products")({
  beforeLoad: () => {
    throw redirect({ to: "/shop-mgmt/products" });
  },
});
