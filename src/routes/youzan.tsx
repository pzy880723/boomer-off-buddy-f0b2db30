import { createFileRoute, redirect } from "@tanstack/react-router";

// 有赞门店已合并到「系统 · API 对接」
export const Route = createFileRoute("/youzan")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/api-integration" });
  },
});
