import { createFileRoute, redirect } from "@tanstack/react-router";

// 旧路径，已合并到 /youzan
export const Route = createFileRoute("/youzan/sync")({
  beforeLoad: () => {
    throw redirect({ to: "/youzan" });
  },
});

