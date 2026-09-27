import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { supabaseAdmin as db } from "../src/integrations/supabase/client.server";
import { releaseSkuToOfflineShopsCore } from "../src/lib/youzan-offline-products.functions";
import { callYouzanApiVerbose, ensureAccessToken, getHqShop } from "../src/lib/youzan.functions";

async function main() {
  const skuId = process.argv[2];
  const expected: Record<string, { barcode: string; price: number; masterCode: string; historical?: boolean }> = {
    "18ace324-fbd1-4c8e-8dcd-12f01329a99e": { barcode: "2006890664290", price: 399, masterCode: "BM529821940370" },
    "fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3": { barcode: "2000128424847", price: 299, masterCode: "BM645119936025" },
    "7e0823f0-821c-4880-97bf-d9f3ef9cc7c7": { barcode: "2002633257323", price: 118, masterCode: "BM51340089729", historical: true },
    "180913be-4395-4d46-a394-10ae57f36e35": { barcode: "2009291436398", price: 299, masterCode: "BM630898433033", historical: true },
  };
  assert.ok(expected[skuId], "Only explicitly audited, unsold listings may be repaired");
  assert.equal(process.env.PUBLIC_APP_ORIGIN, "https://erp.boomeroff.com");
  const historical = expected[skuId].historical;
  const shopId = historical ? "da06cdae-5ec1-4749-8dcb-dc972cfd05c9" : "eecdad4d-6c86-47af-8878-b24cb6f12bd9";
  const locationId = historical ? "7111b585-7d7f-4777-b4ae-61ce2b868f78" : "2df58305-57c1-4792-9920-3c3aa49890bc";
  const kdtId = historical ? 187395218 : 212291308;
  const warehouseCode = historical ? "MD00001" : "MD00003";
  const { data: sku, error } = await db.from("inv_skus").select("id,sku_scope,status,barcode,price_tier,image_paths").eq("id", skuId).single();
  if (error) throw error;
  assert.equal(sku.sku_scope, "custom");
  assert.equal(sku.status, "active");
  assert.equal(sku.barcode, expected[skuId].barcode);
  assert.equal(Number(sku.price_tier), expected[skuId].price);
  assert.ok(sku.image_paths?.length && sku.image_paths.every(p => p.startsWith("sku-listing/")));
  const { data: stocks, error: stockError } = await db.from("inv_stocks").select("location_id,qty").eq("sku_id", skuId);
  if (stockError) throw stockError;
  assert.deepEqual(stocks, [{ location_id: locationId, qty: 1 }], "ERP changed; do not overwrite sales or transfer progress");
  const backup: Record<string, unknown> = { sku, stocks, at: new Date().toISOString() };
  const accessToken = await ensureAccessToken(await getHqShop());
  const detail = await callYouzanApiVerbose({ accessToken, method: "youzan.item.itemdetail.get", version: "1.0.0",
    params: { request: { kdt_id: kdtId, item_code: expected[skuId].masterCode, channel: 1 } } });
  const remote = detail.payload as Record<string, unknown>;
  assert.equal(remote.kdt_id, kdtId);
  assert.equal(remote.item_code, expected[skuId].masterCode);
  assert.equal(Number(remote.sold_num), 0, "Sales appeared; do not restore quantity");
  const warehouse = await callYouzanApiVerbose({ accessToken, method: "youzan.retail.open.query.warehousestock", version: "1.0.0",
    params: { warehouse_code: warehouseCode, sku_codes: [expected[skuId].masterCode] } });
  const rows = warehouse.payload as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1, "Require exact remote warehouse row");
  assert.equal(rows[0].sku_code, expected[skuId].masterCode);
  assert.equal(Number(rows[0].stock_num), 0, "Remote stock changed; inspect before retry");
  assert.equal(Number(rows[0].freeze_num), 0, "Reserved stock must not be overwritten");
  backup.remote = remote;
  backup.warehouse = rows;
  for (const table of ["sku_youzan_links", "sku_channel_listings", "youzan_stock_sync_queue"] as const) {
    const result = await db.from(table).select("*").eq("sku_id", skuId);
    if (result.error) throw result.error;
    backup[table] = result.data;
  }
  const file = `/tmp/youzan-new-listing-${skuId}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(backup, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ backup: file, skuId, shopId }));
  const result = await releaseSkuToOfflineShopsCore({ sku_id: skuId, shop_ids: [shopId] });
  console.log(JSON.stringify(result));
  assert.equal(result.ok, true, "Read the failure and remote state before retrying");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Repair failed"); process.exitCode = 1; });
