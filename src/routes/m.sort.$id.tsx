import { createFileRoute, redirect } from "@tanstack/react-router";

// 旧路由：分拣以包裹为单位的流程已废弃，全部 redirect 回 /m/sort
export const Route = createFileRoute("/m/sort/$id")({
  beforeLoad: () => {
    throw redirect({ to: "/m/sort" });
  },
  component: () => null,
});
