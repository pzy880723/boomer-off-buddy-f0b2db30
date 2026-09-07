import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SalesDashboard } from "@/components/dashboard/sales-dashboard";
import { getDashboardScope, getSalesDashboard } from "@/lib/operational-dashboard.functions";
import { dashboardRange, type DashboardPeriod } from "@/lib/dashboard-view";
import { useAuthSession } from "@/hooks/use-auth-session";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "仪表盘 · BOOMER OFF" },
      { name: "description", content: "销售概况、待处理事项与常用操作" },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { session } = useAuthSession();
  const userId = session?.user.id;
  const scopeFn = useServerFn(getDashboardScope);
  const salesFn = useServerFn(getSalesDashboard);
  const [period, setPeriod] = useState<DashboardPeriod | "custom">("today");
  const [range, setRange] = useState(() => dashboardRange("today"));
  const [selection, setSelection] = useState<{ userId: string; id: string } | null>(null);
  const scope = useQuery({
    queryKey: ["dashboard-scope", userId],
    queryFn: () => scopeFn(),
    enabled: !!userId,
    staleTime: 0,
    retry: 1,
  });
  const selected = selection && selection.userId === userId ? selection.id : undefined;
  const locationId =
    selected &&
    (selected === "all"
      ? scope.data?.isHq
      : scope.data?.locations.some((location) => location.id === selected))
      ? selected
      : scope.data?.isHq
        ? "all"
        : (scope.data?.locations[0]?.id ?? "");
  const query = useQuery({
    queryKey: ["sales-dashboard", userId, locationId, range.start, range.end],
    queryFn: () => salesFn({ data: { ...range, locationId } }),
    enabled: !!userId && !!scope.data && !!locationId,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
  const refresh = () => {
    void scope.refetch();
    if (locationId) void query.refetch();
  };
  return (
    <SalesDashboard
      data={userId && locationId ? query.data : undefined}
      loading={scope.isLoading || query.isLoading}
      refreshing={scope.isFetching || query.isFetching}
      error={scope.error?.message ?? query.error?.message}
      range={range}
      period={period}
      onRange={(next, p) => {
        setRange(next);
        setPeriod(p);
      }}
      locations={scope.data?.locations ?? []}
      isHq={scope.data?.isHq ?? false}
      locationId={locationId}
      onLocation={(id) => {
        if (userId) setSelection({ userId, id });
      }}
      onRefresh={refresh}
    />
  );
}
