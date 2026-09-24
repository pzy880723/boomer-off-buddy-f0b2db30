import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { supabaseAdmin as db } from "../src/integrations/supabase/client.server";
import { callYouzanApiVerbose, ensureAccessToken, getHqShop } from "../src/lib/youzan.functions";
import { cancelYouzanBranchOfflineChannel, queryYouzanBranchChannelProduct, resolveYouzanHqItemId } from "../src/lib/youzan-offline-products.server";

// This repair deliberately cannot accept arbitrary SKU or location arguments.
const duplicate = "e4bc35b6-5363-4084-b2e4-f0426e53970d";
const original = "64df5917-813a-49fd-bd9e-7b1afe717806";
const location = "2df58305-57c1-4792-9920-3c3aa49890bc";
const kdt = 212291308;
const apply = process.argv[2] === "apply";
assert.ok([undefined, "inspect", "apply"].includes(process.argv[2]));
const hq = await getHqShop();
const accessToken = await ensureAccessToken(hq);
async function api(method: string, version: string, params: Record<string, unknown>) {
  return (await callYouzanApiVerbose({ accessToken, method, version, params, timeoutMs: 30_000 })).payload as any;
}
async function rows(table: string, columns: string, field: string, values: string[]) {
  const result = await (db as any).from(table).select(columns).in(field, values);
  if (result.error) throw new Error(result.error.message);
  return result.data as any[];
}
const skus = await rows("inv_skus", "id,sku_code,barcode,name,price_tier,status,is_display", "id", [original, duplicate]);
const stocks = await rows("inv_stocks", "sku_id,location_id,qty", "sku_id", [original, duplicate]);
const links = await rows("sku_youzan_links", "sku_id,shop_id,yz_item_id,yz_sku_id", "sku_id", [original, duplicate]);
const removed = skus.find(s => s.id === duplicate);
const kept = skus.find(s => s.id === original);
assert.equal(removed?.barcode, "2000770020756");
assert.equal(kept?.barcode, "2005336838530");
assert.equal(Number(kept.price_tier), 159);
assert.deepEqual(stocks.filter(s => s.sku_id === original).map(({ location_id, qty }) => ({ location_id, qty })), [{ location_id: location, qty: 1 }]);
const hqLink = links.find(l => l.sku_id === duplicate && l.shop_id === hq.id);
assert.equal(Number(hqLink?.yz_item_id), 5287310312);
const master = (await api("youzan.retail.open.spu.query", "3.0.0", { page_no: 1, page_size: 20, spu_ids: [5287310312] })).spus?.find((s: any) => Number(s.spu_id) === 5287310312);
assert.ok(master);
assert.equal(master.skus.length, 1);
const stockParams = { warehouse_code: "MD00003", sku_codes: [master.skus[0].sku_code] };
const remoteStock = await api("youzan.retail.open.query.warehousestock", "1.0.0", stockParams);
const channel = await queryYouzanBranchChannelProduct({ accessToken, kdtId: kdt, itemCode: master.spu_code });
console.log(JSON.stringify({ skus, stocks, remoteStock, channel }));
if (apply) {
  assert.equal(removed.status, "archived", "ERP reversal/archive must finish first");
  assert.equal(removed.is_display, false);
  assert.ok(stocks.filter(s => s.sku_id === duplicate).every(s => Number(s.qty) === 0));
  const stock = remoteStock.find((s: any) => s.sku_code === master.skus[0].sku_code);
  assert.ok(stock);
  assert.equal(Number(stock.freeze_num), 0, "Never overwrite reserved stock");
  assert.ok([0, 1].includes(Number(stock.stock_num)));
  writeFileSync(`/tmp/toyhouse-duplicate-backup-${Date.now()}.json`, JSON.stringify({ skus, stocks, links, master, remoteStock, channel }), { mode: 0o600 });
  if (Number(stock.stock_num) !== 0) {
    await api("youzan.retail.open.stock.adjust", "3.0.0", {
      warehouse_code: "MD00003", creator: "BOOMER ERP", remark: "撤销重复上架玩具屋，保留首次入库商品",
      source_order_no: "DUP0924e4bc35b653634084b2e4",
      create_time: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "),
      order_items: [{ sku_code: master.skus[0].sku_code, quantity: "0" }],
    });
  }
  if (channel?.isDisplay) {
    const identity = await resolveYouzanHqItemId({ accessToken, hqKdtId: Number(hq.kdt_id), itemCode: master.spu_code });
    await cancelYouzanBranchOfflineChannel({ accessToken, branchKdtId: kdt, hqItemId: identity.itemId });
  }
  const afterStock = await api("youzan.retail.open.query.warehousestock", "1.0.0", stockParams);
  assert.equal(Number(afterStock.find((s: any) => s.sku_code === master.skus[0].sku_code)?.stock_num), 0);
  const afterChannel = await queryYouzanBranchChannelProduct({ accessToken, kdtId: kdt, itemCode: master.spu_code });
  assert.ok(!afterChannel?.isDisplay);
  const shopId = "eecdad4d-6c86-47af-8878-b24cb6f12bd9";
  for (const [table, patch] of [
    ["sku_youzan_links", { status: "linked", sync_stock: false, last_pushed_stock: 0, last_error: null }],
    ["sku_channel_listings", { listing_status: "delisted", last_stock: 0, last_error: null, last_verified_at: new Date().toISOString() }],
    ["youzan_stock_sync_queue", { status: "done", target_stock: 0, reason: "duplicate_listing_reversed", last_error: null }],
  ] as const) {
    const result = await (db as any).from(table).update(patch).eq("sku_id", duplicate).eq("shop_id", shopId);
    if (result.error) throw new Error(result.error.message);
  }
  console.log(JSON.stringify({ verified: true, barcode: removed.barcode, stock: afterStock, channel: afterChannel }));
}
