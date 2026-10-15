// BOOMER GO 员工龙虎榜（只读）。当前订单没有可信的"销售归属"字段（有赞仅有收银员，不等于销售人），
// 因此按约定返回明确不可用的空榜：complete=false + reason，绝不按收银员/录入人推断，也不参与考核。
import { GoScopeError, resolveGoScope } from "./scope";
import { shanghaiToday } from "@/lib/store-targets/sales-window";

export type LeaderboardPeriod = "today" | "month";

export function parseLeaderboardPeriod(v: string | null): LeaderboardPeriod | null {
  if (v == null || v === "") return "today";
  return v === "today" || v === "month" ? v : null;
}

type ActorLike = {
  is_hq: boolean;
  schedule_state: "scheduled" | "off" | "no_schedule" | "unavailable";
  today_location: { id: string; name: string } | null;
  hq_locations: { id: string; name: string }[];
};

export function buildGoLeaderboard(input: {
  actor: ActorLike;
  period: LeaderboardPeriod;
  requestedLocationId: string | null;
  now?: Date;
}) {
  const { actor } = input;
  // 只提供单店员工榜：总部必须指定一个已授权门店，不做跨店门店榜。
  if (actor.is_hq && !input.requestedLocationId) {
    throw new GoScopeError("location_required", "请指定要查看的门店", 422);
  }
  const scope = resolveGoScope({
    isHq: actor.is_hq,
    requestedLocationId: input.requestedLocationId,
    scheduleState: actor.schedule_state,
    scheduledLocationId: actor.today_location?.id ?? null,
    hqLocationIds: actor.hq_locations.map((l) => l.id),
  });
  const id = scope.locationIds[0];
  const shop = actor.is_hq
    ? actor.hq_locations.find((l) => l.id === id) ?? null
    : actor.today_location && actor.today_location.id === id ? actor.today_location : null;
  if (!shop) throw new GoScopeError("location_forbidden", "门店未绑定，无法查看");
  const now = input.now ?? new Date();
  const today = shanghaiToday(now);
  return {
    period: input.period,
    date: input.period === "month" ? today.slice(0, 7) : today,
    as_of: now.toISOString(),
    complete: false as const,
    scope: "shop" as const,
    shop: { id: shop.id, name: shop.name },
    rows: [] as Array<{ rank: number; display_name: string; achieved_cents: number; is_me: boolean }>,
    sales_assessment: false as const,
    reason: "employee_attribution_unavailable" as const,
    message: "订单尚未记录销售归属，暂不能生成员工龙虎榜",
  };
}
