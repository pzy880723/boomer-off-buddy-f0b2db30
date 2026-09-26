import assert from "node:assert/strict";
import { supabaseAdmin as db } from "../src/integrations/supabase/client.server";
import { callYouzanApiVerbose, ensureAccessToken, getHqShop } from "../src/lib/youzan.functions";
import { queryYouzanBranchChannelProduct } from "../src/lib/youzan-offline-products.server";
import { releaseSkuToOfflineShopsCore } from "../src/lib/youzan-offline-products.functions";

const locationId = "2df58305-57c1-4792-9920-3c3aa49890bc";
const shopId = "eecdad4d-6c86-47af-8878-b24cb6f12bd9";
const skuId = process.argv[2];
const repair = process.argv[3] === "--repair";
const verify = process.argv[3] === "--verify";
assert.match(skuId ?? "", /^[a-f0-9-]{36}$/);
const { data: sku, error } = await db.from("inv_skus")
  .select("id,name,barcode,sku_scope,status,is_display,price_tier,created_at").eq("id", skuId).single();
if (error) throw error;
assert.equal(sku.sku_scope, "custom");
const { data: stocks, error: stockError } = await db.from("inv_stocks").select("location_id,qty").eq("sku_id", skuId);
if (stockError) throw stockError;
const { data: shop, error: shopError } = await db.from("youzan_shops").select("id,kdt_id,warehouse_code").eq("id", shopId).single();
if (shopError) throw shopError;
assert.equal(Number(shop.kdt_id), 212291308);
assert.equal(shop.warehouse_code, "MD00003");
const hq = await getHqShop();
const token = await ensureAccessToken(hq);
const { data: link, error: linkError } = await db.from("sku_youzan_links").select("yz_item_id").eq("sku_id", skuId).eq("shop_id", hq.id).single();
if (linkError) throw linkError;
const masterResult = await callYouzanApiVerbose({ accessToken: token, method: "youzan.retail.open.spu.query", version: "3.0.0",
  params: { page_no: 1, page_size: 20, spu_ids: [Number(link.yz_item_id)] }, timeoutMs: 20000 });
const master = (masterResult.payload as any).spus?.find((r: any) => Number(r.spu_id) === Number(link.yz_item_id));
assert.ok(master, "HQ master missing");
async function inspect() {
  const product = await queryYouzanBranchChannelProduct({ accessToken: token, kdtId: Number(shop.kdt_id), itemCode: master.spu_code });
  const stockResult = await callYouzanApiVerbose({ accessToken: token, method: "youzan.retail.open.query.warehousestock", version: "1.0.0",
    params: { warehouse_code: shop.warehouse_code, sku_codes: [master.skus[0].sku_code] }, timeoutMs: 20000 });
  return { sku, stocks, product, warehouseStock: stockResult.payload };
}
const before = await inspect();
console.log(JSON.stringify({ phase: "before", ...before }));
if (verify) {
  const expectedStock = stocks.find(s => s.location_id === locationId)?.qty ?? 0;
  assert.equal(before.product?.spuNo, sku.barcode, "POS barcode mismatch");
  assert.equal(before.product?.skus[0]?.price, Number(sku.price_tier), "POS price mismatch");
  assert.equal(before.product?.isDisplay, sku.is_display, "POS shelf state mismatch");
  assert.equal(Number((before.warehouseStock as any[]).find(r => r.sku_code === master.skus[0].sku_code)?.stock_num), expectedStock, "Warehouse stock mismatch");
  const { data: otherShops, error: otherError } = await db.from("youzan_shops").select("id,kdt_id,shop_name").eq("role", "branch").neq("id", shopId);
  if (otherError) throw otherError;
  assert.ok(stocks.every(s => s.location_id === locationId || s.qty === 0), "Recheck multi-location stock before checking scope");
  for (const other of otherShops) {
    const product = await queryYouzanBranchChannelProduct({ accessToken: token, kdtId: Number(other.kdt_id), itemCode: master.spu_code });
    assert.ok(!product?.isDisplay, `Unexpected visible product in ${other.shop_name}`);
  }
  console.log(JSON.stringify({ verified: true, skuId, barcode: sku.barcode, qty: expectedStock, otherShopsHidden: otherShops.length }));
}
if (repair) {
  assert.equal(sku.status, "active");
  assert.equal(sku.is_display, true);
  assert.ok(sku.created_at >= "2026-09-25");
  assert.deepEqual(stocks, [{ location_id: locationId, qty: 1 }]);
  const remoteStocks = before.warehouseStock as any[];
  assert.ok(remoteStocks.every(r => Number(r.freeze_num) === 0 && Number(r.stock_num) === 0), "Remote inventory changed; manual reconciliation required");
  const { count, error: reservationError } = await db.from("inventory_reservations").select("id", { count: "exact", head: true }).eq("sku_id", skuId).eq("status", "active");
  if (reservationError) throw reservationError;
  assert.equal(count, 0, "Active order reservation");
  console.log(JSON.stringify({ phase: "repair", result: await releaseSkuToOfflineShopsCore({ sku_id: skuId, shop_ids: [shopId] }) }));
  console.log(JSON.stringify({ phase: "after", ...await inspect() }));
}
