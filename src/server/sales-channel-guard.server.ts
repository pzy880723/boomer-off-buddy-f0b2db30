// 有赞写入前的渠道意图复核（worker / 旧队列共用）。不调用有赞；读取失败 = 不放行。
type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function loadIntentTaskFacts(
  sb: Sb,
  task: { sku_id: string; request_payload?: unknown },
): Promise<{ intent: { enabled: boolean; version: number } | null; salesState: string | null; stockQty: number | null; readFailed: boolean }> {
  const locationId = (task.request_payload as { location_id?: string } | null)?.location_id;
  if (!locationId) return { intent: null, salesState: null, stockQty: null, readFailed: true };
  const [intent, sku, stock] = await Promise.all([
    sb.from("sku_sales_channel_intents").select("enabled, version")
      .eq("sku_id", task.sku_id).eq("location_id", locationId).eq("channel", "youzan").maybeSingle(),
    sb.from("inv_skus").select("sales_state").eq("id", task.sku_id).maybeSingle(),
    sb.from("inv_stocks").select("qty").eq("sku_id", task.sku_id).eq("location_id", locationId).maybeSingle(),
  ]);
  if (intent.error || sku.error || stock.error) return { intent: null, salesState: null, stockQty: null, readFailed: true };
  return {
    intent: intent.data ? { enabled: !!intent.data.enabled, version: Number(intent.data.version) } : null,
    salesState: sku.data?.sales_state ?? null,
    stockQty: stock.data ? Number(stock.data.qty) : null,
    readFailed: false,
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
