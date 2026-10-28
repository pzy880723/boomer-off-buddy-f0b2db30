// 有赞写入前的渠道意图复核（worker / 旧队列 / 旧发布共用）。不调用有赞；读取失败 = 不放行。
import type { IntentTaskFacts } from "@/lib/sales-channels/model";

type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

type IntentTask = { sku_id: string; shop_id?: string | null; channel_listing_id?: string | null; request_payload?: unknown };

const FAILED: IntentTaskFacts = { intent: null, salesState: null, stockQty: null, readFailed: true };

/** 同店同一有赞 item 是否关联了其他 ERP SKU（多规格/价格档共享收银商品）。读取失败抛错。 */
export async function youzanItemSharedInShop(sb: Sb, shopId: string, externalItemId: string, skuId: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    sb.from("sku_channel_listings").select("sku_id").eq("channel", "youzan_branch_offline")
      .eq("shop_id", shopId).eq("external_item_id", externalItemId).neq("sku_id", skuId).limit(1),
    /^\d+$/.test(externalItemId)
      ? sb.from("sku_youzan_links").select("sku_id").eq("shop_id", shopId).eq("yz_item_id", Number(externalItemId)).neq("sku_id", skuId).limit(1)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (a.error || b.error) throw new Error("共享商品检查失败");
  return (a.data ?? []).length > 0 || (b.data ?? []).length > 0;
}

/** 读取意图任务执行所需全部事实：意图、售出、库存、库位/映射/门店归属、共享 item。 */
export async function loadIntentTaskFacts(sb: Sb, task: IntentTask): Promise<IntentTaskFacts> {
  const locationId = (task.request_payload as { location_id?: string } | null)?.location_id;
  if (!locationId) return FAILED;
  const [intent, sku, stock, loc, listing, shop] = await Promise.all([
    sb.from("sku_sales_channel_intents").select("enabled, version")
      .eq("sku_id", task.sku_id).eq("location_id", locationId).eq("channel", "youzan").maybeSingle(),
    sb.from("inv_skus").select("sales_state").eq("id", task.sku_id).maybeSingle(),
    sb.from("inv_stocks").select("qty").eq("sku_id", task.sku_id).eq("location_id", locationId).maybeSingle(),
    sb.from("inv_locations").select("shop_id, is_active, kind").eq("id", locationId).maybeSingle(),
    task.channel_listing_id
      ? sb.from("sku_channel_listings").select("sku_id, shop_id, channel, external_item_id").eq("id", task.channel_listing_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.shop_id
      ? sb.from("youzan_shops").select("status").eq("id", task.shop_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (intent.error || sku.error || stock.error || loc.error || listing.error || shop.error) return FAILED;
  const l = listing.data as IntentTaskFacts["listing"];
  let shared = false;
  if (l?.external_item_id && l.shop_id) {
    try { shared = await youzanItemSharedInShop(sb, l.shop_id, l.external_item_id, task.sku_id); }
    catch { return FAILED; }
  }
  return {
    intent: intent.data ? { enabled: !!intent.data.enabled, version: Number(intent.data.version) } : null,
    salesState: sku.data?.sales_state ?? null,
    stockQty: stock.data ? Number(stock.data.qty) : null,
    readFailed: false,
    location: (loc.data as IntentTaskFacts["location"]) ?? null,
    listing: l ?? null,
    shopActive: (shop.data as { status?: string } | null)?.status === "active",
    shared,
  };
}

/** 该 SKU 在此有赞门店对应的 ERP 门店是否被显式关闭有赞渠道。读取失败抛错。 */
export async function youzanIntentDisabledForShop(sb: Sb, skuId: string, shopId: string | null): Promise<boolean> {
  if (!shopId) return false;
  const { data: locs, error } = await sb.from("inv_locations").select("id").eq("shop_id", shopId);
  if (error) throw new Error("渠道策略读取失败（门店）");
  const ids = ((locs ?? []) as Array<{ id: string }>).map((l) => l.id);
  if (!ids.length) return false;
  const { data, error: e2 } = await sb.from("sku_sales_channel_intents").select("sku_id")
    .eq("sku_id", skuId).eq("channel", "youzan").eq("enabled", false).in("location_id", ids).limit(1);
  if (e2) throw new Error("渠道策略读取失败");
  return (data ?? []).length > 0;
}

export class YouzanChannelDisabledError extends Error {
  constructor() { super("本店已关闭有赞渠道，未发布到收银台"); }
}

/** 旧发布路径（offline release / update）在实际有赞上架写入前调用：关闭则抛错，不发布。 */
export async function assertYouzanPublishAllowed(sb: Sb, skuId: string, shopId: string): Promise<void> {
  if (await youzanIntentDisabledForShop(sb, skuId, shopId)) throw new YouzanChannelDisabledError();
}
