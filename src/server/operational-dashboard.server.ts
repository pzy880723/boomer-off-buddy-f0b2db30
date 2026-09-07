import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  aggregateSales,
  chooseDashboardScope,
  type CommerceSale,
  type YouzanSale,
} from "@/lib/sales-dashboard";
import {
  validateDashboardRange,
  type DashboardRange,
  type DashboardDisplay,
} from "@/lib/dashboard-view";

// Dashboard UI adapter: return aggregates only, never credentials or customer fields.
const db = supabaseAdmin;
type Location = { id: string; name: string; shop_id: string | null };
type Page<T> = { data: T[] | null; error: { message: string } | null };
async function allRows<T>(query: (from: number, to: number) => PromiseLike<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const result = await query(rows.length, rows.length + 499);
    if (result.error) throw new Error(result.error.message);
    if (!result.data?.length) return rows;
    rows.push(...result.data);
  }
}

export async function dashboardScope(userId: string) {
  const roles = await db.from("user_roles").select("role").eq("user_id", userId);
  if (roles.error) throw new Error("读取账号权限失败");
  const names = (roles.data ?? []).map((row) => String(row.role));
  const isHq = names.some((role) => ["super_admin", "hq_operator"].includes(role));
  if (
    !isHq &&
    !names.some((role) => ["store_manager", "store_staff", "warehouse_staff"].includes(role))
  )
    throw new Error("当前账号没有经营数据查看权限");
  let query = db
    .from("inv_locations")
    .select("id,name,shop_id")
    .eq("is_active", true)
    .order("name");
  if (!isHq) {
    const permissions = await db
      .from("user_location_perms")
      .select("location_id")
      .eq("user_id", userId);
    if (permissions.error) throw new Error("读取门店授权失败");
    const ids = (permissions.data ?? []).map((row) => row.location_id);
    if (!ids.length) throw new Error("当前账号尚未授权任何门店，请联系总部管理员");
    query = query.in("id", ids);
  }
  const result = await query;
  if (result.error) throw new Error("读取门店列表失败");
  return { isHq, locations: (result.data ?? []) as Location[] };
}

export async function loadSalesDashboard(
  userId: string,
  input: DashboardRange & { locationId?: string },
): Promise<DashboardDisplay> {
  const issue = validateDashboardRange(input);
  if (issue) throw new Error(issue);
  const scope = await dashboardScope(userId);
  const locationId = chooseDashboardScope(
    scope.isHq,
    scope.locations.map((row) => row.id),
    input.locationId,
  );
  const all = locationId === "all";
  const locations = all ? scope.locations : scope.locations.filter((row) => row.id === locationId);
  const locationIds = locations.map((row) => row.id);
  const shopIds = [
    ...new Set(locations.map((row) => row.shop_id).filter((id): id is string => !!id)),
  ];
  const trendStart = new Date(Date.parse(input.end) - 6 * 86_400_000).toISOString().slice(0, 10);
  const start = `${input.start < trendStart ? input.start : trendStart}T00:00:00+08:00`;
  const end = new Date(Date.parse(`${input.end}T00:00:00+08:00`) + 86_400_000).toISOString();
  const warnings: string[] = [];
  const [commerce, youzan] = await Promise.all([
    allRows<CommerceSale>((from, to) => {
      let query = db
        .from("commerce_orders")
        .select(
          `id,order_no,source_channel,paid_at,payment_status,order_status,currency,total_amount,items:commerce_order_items(id,location_id,quantity,line_total),refunds:commerce_refunds(amount,status,after_sale:commerce_after_sales!after_sale_id(order_item_id)),pos_returns(status,location_id,refund_total)${all ? "" : ",scope_items:commerce_order_items!inner(location_id)"}`,
        )
        .in("source_channel", ["pos", "storefront", "manual"])
        .gte("paid_at", start)
        .lt("paid_at", end)
        .order("id")
        .range(from, to);
      if (!all) query = query.in("scope_items.location_id", locationIds);
      return query as unknown as PromiseLike<Page<CommerceSale>>;
    }),
    shopIds.length
      ? allRows<YouzanSale>((from, to) =>
          db
            .from("youzan_orders")
            .select("tid,shop_id,pay_time,status,payment,total_fee,num,outer_transaction_no")
            .in("shop_id", shopIds)
            .gte("pay_time", start)
            .lt("pay_time", end)
            .order("id")
            .range(from, to),
        )
      : Promise.resolve([]),
  ]);
  const sales = aggregateSales({
    range: input,
    locationIds,
    all,
    commerce,
    youzan,
    hasYouzan: shopIds.length > 0,
  });
  await Promise.all(
    locations
      .filter((row) => row.shop_id)
      .map(async (location) => {
        const sync = await db
          .from("youzan_sync_logs")
          .select("finished_at")
          .eq("shop_id", location.shop_id!)
          .eq("action", "orders")
          .eq("status", "ok")
          .order("finished_at", { ascending: false, nullsFirst: false })
          .limit(1);
        const time = sync.data?.[0]?.finished_at;
        const effectiveEnd = Math.min(Date.parse(end), Date.now());
        if (sync.error || !time)
          warnings.push(`${location.name}：未取得订单同步成功时间，请检查有赞同步。`);
        else if (Date.parse(time) + 60 * 60_000 < effectiveEnd)
          warnings.push(
            `${location.name}：订单同步滞后，最近成功于 ${new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}。`,
          );
      }),
  );

  async function count(
    label: string,
    query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
  ) {
    const result = await query;
    if (result.error || result.count === null) {
      warnings.push(`${label}暂时无法读取，请进入对应页面核对。`);
      return null;
    }
    return result.count;
  }
  function fulfillmentCount(statuses: string[]) {
    let q = db
      .from("fulfillments")
      .select("id,order:commerce_orders!inner(order_status,payment_status)", {
        head: true,
        count: "exact",
      })
      .in("status", statuses)
      .not("order.order_status", "in", "(cancelled,closed)")
      .in("order.payment_status", ["paid", "refund_pending", "partially_refunded"]);
    if (!all) q = q.in("location_id", locationIds);
    return q;
  }
  let shortagesQuery = db
    .from("fulfillment_shortages")
    .select(
      "id,fulfillment:fulfillments!inner(location_id,order:commerce_orders!inner(order_status))",
      { head: true, count: "exact" },
    )
    .eq("status", "pending_customer")
    .not("fulfillment.order.order_status", "in", "(cancelled,closed)");
  if (!all) shortagesQuery = shortagesQuery.in("fulfillment.location_id", locationIds);
  let afterQuery = db
    .from("commerce_after_sales")
    .select("id", { head: true, count: "exact" })
    .in("status", [
      "requested",
      "store_reviewing",
      "store_received",
      "inspecting",
      "refund_pending",
    ]);
  if (!all) afterQuery = afterQuery.in("location_id", locationIds);
  async function unreadSupport() {
    try {
      const conversations = await allRows<{ messages: Array<{ sender_type: string }> }>(
        (from, to) => {
          let q = db
            .from("support_conversations")
            .select("id,messages:support_messages(sender_type,created_at)")
            .in("status", ["open", "pending"])
            .eq("messages.internal", false)
            .in("messages.sender_type", ["customer", "staff"])
            .order("id")
            .order("created_at", { referencedTable: "messages", ascending: false })
            .limit(1, { referencedTable: "messages" })
            .range(from, to);
          if (!all) q = q.in("location_id", locationIds);
          return q as unknown as PromiseLike<Page<{ messages: Array<{ sender_type: string }> }>>;
        },
      );
      return conversations.filter((row) => row.messages[0]?.sender_type === "customer").length;
    } catch {
      warnings.push("未回复消息暂时无法读取，请进入客服核对。");
      return null;
    }
  }
  let stockQuery = db
    .from("youzan_stock_sync_queue")
    .select("id", { head: true, count: "exact" })
    .eq("status", "failed");
  let outboxQuery = db
    .from("channel_sync_outbox")
    .select("id", { head: true, count: "exact" })
    .in("status", ["failed", "dead"]);
  if (!all) {
    stockQuery = stockQuery.in("shop_id", shopIds);
    outboxQuery = outboxQuery.in("shop_id", shopIds);
  }
  const [picking, shipping, shortages, afterSales, support, stockFailures, outboxFailures] =
    await Promise.all([
      count("待备货", fulfillmentCount(["unallocated", "allocated", "picking"])),
      count("待发货", fulfillmentCount(["picked", "packing", "packed", "handover_ready"])),
      count("缺货待确认", shortagesQuery),
      count("待处理售后", afterQuery),
      unreadSupport(),
      !all && !shopIds.length ? 0 : count("库存同步失败", stockQuery),
      !all && !shopIds.length ? 0 : count("渠道同步失败", outboxQuery),
    ]);
  return {
    ...sales,
    scopeLabel: all ? "全部门店与总部" : locations[0].name,
    fetchedAt: new Date().toISOString(),
    isHq: scope.isHq,
    warnings: [...sales.warnings, ...warnings],
    tasks: [
      { key: "picking", label: "待备货", count: picking, href: "/orders/online" },
      { key: "shipping", label: "待发货", count: shipping, href: "/orders/online" },
      { key: "shortages", label: "缺货待确认", count: shortages, href: "/orders/online" },
      { key: "afterSales", label: "待处理售后", count: afterSales, href: "/orders/after-sales" },
      { key: "support", label: "未回复消息", count: support, href: "/customer-service" },
      {
        key: "sync",
        label: "同步失败任务",
        count:
          stockFailures === null || outboxFailures === null ? null : stockFailures + outboxFailures,
        href: "/youzan",
      },
    ],
  };
}
