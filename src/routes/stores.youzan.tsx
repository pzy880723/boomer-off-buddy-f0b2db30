import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/stores/youzan")({
  beforeLoad: () => {
    throw redirect({ to: "/youzan" });
  },
});
