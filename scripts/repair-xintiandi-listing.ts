import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { supabaseAdmin as db } from "../src/integrations/supabase/client.server";
import { releaseSkuToOfflineShopsCore } from "../src/lib/youzan-offline-products.functions";

const skuId = process.argv[2];
assert.ok(["64df5917-813a-49fd-bd9e-7b1afe717806", "e4bc35b6-5363-4084-b2e4-f0426e53970d"].includes(skuId), "Incident SKU only");
const locationId = "2df58305-57c1-4792-9920-3c3aa49890bc";
const shopId = "eecdad4d-6c86-47af-8878-b24cb6f12bd9";
const { data: sku, error } = await db.from("inv_skus").select("id,sku_code,barcode,price_tier,sku_scope").eq("id", skuId).single();
if (error) throw error;
assert.equal(sku.sku_scope, "custom");
assert.equal(Number(sku.price_tier), 159);
const { data: stocks, error: stockError } = await db.from("inv_stocks").select("*").eq("sku_id", skuId);
if (stockError) throw stockError;
assert.equal(stocks.length, 1);
assert.equal(stocks[0].location_id, locationId);
assert.equal(stocks[0].qty, 1);
const snapshot: Record<string, unknown> = { sku, stocks };
for (const table of ["sku_youzan_links", "sku_channel_listings", "youzan_stock_sync_queue"] as const) {
  const { data, error: readError } = await db.from(table).select("*").eq("sku_id", skuId);
  if (readError) throw readError;
  snapshot[table] = data;
}
const backup = `/tmp/xintiandi-core-${skuId}-${Date.now()}.json`;
writeFileSync(backup, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ backup, sku, locationId, shopId }));
const result = await releaseSkuToOfflineShopsCore({ sku_id: skuId, shop_ids: [shopId] });
console.log(JSON.stringify(result));
assert.equal(result.ok, true, "Sync did not finish; inspect the reported error");
