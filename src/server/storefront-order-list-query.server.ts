// 订单列表取数层：一次嵌套批量查询 + 门店批量查询 + 图片一次批量签名。
// client 与 signer 均可注入，便于用 mock fetch 断言真实查询构造（归属过滤、字段白名单）。
import {
  buildImageMap,
  buildOrderListItem,
  coarseStatusFilter,
  collectImageRefs,
  parseOrdersListQuery,
  selectOrdersPage,
  type OrderCursor,
  type OrderListItem,
  type OrderRow,
  type StoreInfo,
} from "./storefront-order-list.server";

export class OrderListError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/** 字段白名单：不选地址、手机号、EPC、支付快照、结算快照、备注。 */
export const ORDER_LIST_SELECT = [
  "id, order_no, order_status, payment_status, total_amount, shipping_fee, discount_total, currency, courier_provider, courier_service_code, paid_at, created_at, courier_quote_snapshot",
  "items:commerce_order_items(id, location_id, title_snapshot, image_snapshot, unit_price, quantity, line_total, listing_id, sku_id, sku:inv_skus(image_paths, image_url), listing:commerce_listings(image_paths, cover_url))",
  "fulfillments(location_id, status)",
].join(", ");

export const LOCATION_SELECT = "id, name, shop:youzan_shops(id, shop_name)";

export type PathSigner = (paths: readonly string[]) => Promise<(string | null)[]>;

/** 默认签名：缩略图优先，失败或缺失回退原图签名。 */
export async function defaultSignPaths(paths: readonly string[]): Promise<(string | null)[]> {
  if (paths.length === 0) return [];
  const { signSkuImagePaths, signSkuThumbnailPaths } = await import(
    "@/lib/sku-image-resolver.server"
  );
  let thumbs: (string | null)[] = [];
  try {
    thumbs = await signSkuThumbnailPaths(paths);
  } catch {
    thumbs = [];
  }
  let originals: (string | null)[] = [];
  if (thumbs.length !== paths.length || thumbs.some((url) => !url)) {
    try {
      originals = await signSkuImagePaths(paths);
    } catch {
      originals = [];
    }
  }
  return paths.map((_, i) => thumbs[i] ?? originals[i] ?? null);
}

type QueryClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
};

export async function listStorefrontOrders(options: {
  client: QueryClient;
  customerId: string;
  url: URL;
  signPaths?: PathSigner;
}): Promise<{ ok: true; data: OrderListItem[]; has_more: boolean; next_cursor: string | null }> {
  const { client, customerId, url } = options;
  const signPaths = options.signPaths ?? defaultSignPaths;

  let query;
  try {
    query = parseOrdersListQuery(url);
  } catch (error) {
    throw new OrderListError(error instanceof Error ? error.message : "Invalid query", 400);
  }

  const coarse = coarseStatusFilter(query.status);

  // 键集分页：created_at desc, id desc；游标值已在 parse 阶段严格白名单校验。
  const fetchBatch = async ({ cursor, size }: { cursor: OrderCursor | null; size: number }) => {
    let builder = client
      .from("commerce_orders")
      .select(ORDER_LIST_SELECT)
      .eq("customer_id", customerId);
    if (coarse.orderStatuses) builder = builder.in("order_status", coarse.orderStatuses);
    if (coarse.paymentStatuses) builder = builder.in("payment_status", coarse.paymentStatuses);
    if (cursor) {
      builder = builder.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
      );
    }
    const { data, error } = await builder
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(size);
    if (error) throw new OrderListError(error.message, 500);
    return (data ?? []) as OrderRow[];
  };

  const page = await selectOrdersPage(fetchBatch, query);

  // 门店信息：整页一次批量查询（不做逐单详情 N+1）
  const locationIds = Array.from(
    new Set(
      page.rows.flatMap((row) =>
        (row.items ?? []).map((item) => item.location_id).filter((id): id is string => !!id),
      ),
    ),
  );
  const stores = new Map<string, StoreInfo>();
  if (locationIds.length > 0) {
    const { data, error } = await client
      .from("inv_locations")
      .select(LOCATION_SELECT)
      .in("id", locationIds);
    if (error) throw new OrderListError(error.message, 500);
    for (const row of (data ?? []) as Array<{
      id: string;
      name: string | null;
      shop: { id: string | null; shop_name: string | null } | null;
    }>) {
      stores.set(row.id, {
        store_id: row.shop?.id ?? null,
        store_name: row.shop?.shop_name ?? row.name ?? null,
      });
    }
  }

  // 图片：整页拍平去重后一次批量签名
  const { refs, paths } = collectImageRefs(page.rows);
  const signed = paths.length > 0 ? await signPaths(paths) : [];
  const images = buildImageMap(refs, paths, signed);

  return {
    ok: true,
    data: page.rows.map((row) => buildOrderListItem(row, { stores, images })),
    has_more: page.hasMore,
    next_cursor: page.nextCursor,
  };
}
