import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/inventory/products")({
  beforeLoad: () => {
    throw redirect({ to: "/inventory/skus" });
  },
});
