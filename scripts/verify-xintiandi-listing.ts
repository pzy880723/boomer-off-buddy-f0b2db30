import assert from "node:assert/strict";
import { supabaseAdmin as db } from "../src/integrations/supabase/client.server";
import { callYouzanApiVerbose, ensureAccessToken, getHqShop } from "../src/lib/youzan.functions";
import { assertCustomBranchProduct, queryYouzanBranchChannelProduct } from "../src/lib/youzan-offline-products.server";

const locationId = "2df58305-57c1-4792-9920-3c3aa49890bc";
const targetKdt = 212291308;
const hq = await getHqShop();
const accessToken = await ensureAccessToken(hq);
const { data: shops, error: shopError } = await db.from("youzan_shops").select("id,kdt_id,shop_name,warehouse_code").eq("role", "branch");
if (shopError) throw shopError;
for (const skuId of ["64df5917-813a-49fd-bd9e-7b1afe717806", "e4bc35b6-5363-4084-b2e4-f0426e53970d"]) {
  const removed = skuId === "e4bc35b6-5363-4084-b2e4-f0426e53970d";
  const expectedQty = removed ? 0 : 1;
  const { data: sku, error } = await db.from("inv_skus").select("id,sku_code,barcode,price_tier,status,is_display").eq("id", skuId).single();
  if (error) throw error;
  assert.equal(sku.status, removed ? "archived" : "active");
  assert.equal(sku.is_display, !removed);
  assert.equal(Number(sku.price_tier), 159);
  const { data: stocks, error: stockError } = await db.from("inv_stocks").select("location_id,qty").eq("sku_id", skuId);
  if (stockError) throw stockError;
  assert.deepEqual(stocks, [{ location_id: locationId, qty: expectedQty }]);
  const { data: link, error: linkError } = await db.from("sku_youzan_links").select("yz_item_id").eq("sku_id", skuId).eq("shop_id", hq.id).single();
  if (linkError) throw linkError;
  const masterResult = await callYouzanApiVerbose({ accessToken, method: "youzan.retail.open.spu.query", version: "3.0.0",
    params: { page_no: 1, page_size: 20, spu_ids: [Number(link.yz_item_id)] }, timeoutMs: 20_000 });
  const master = (masterResult.payload as { spus: Array<{ spu_id: number; spu_code: string; skus: Array<{ sku_code: string }> }> }).spus.find(row => Number(row.spu_id) === Number(link.yz_item_id));
  assert.ok(master, "HQ product missing");
  const branches = [];
  for (const shop of shops) {
    const product = await queryYouzanBranchChannelProduct({ accessToken, kdtId: Number(shop.kdt_id), itemCode: master.spu_code });
    if (Number(shop.kdt_id) !== targetKdt) {
      assert.ok(!product || !product.isDisplay, `Unexpected publication in ${shop.shop_name}`);
      branches.push({ shop: shop.shop_name, visible: product?.isDisplay ?? false });
      continue;
    }
    if (removed) {
      assert.ok(!product?.isDisplay, "Reversed duplicate is still published");
    } else {
      assertCustomBranchProduct(product, { barcode: sku.barcode!, priceYuan: Number(sku.price_tier) });
      assert.equal(product.isDisplay, true);
    }
    const result = await callYouzanApiVerbose({ accessToken, method: "youzan.retail.open.query.warehousestock", version: "1.0.0",
      params: { warehouse_code: shop.warehouse_code, sku_codes: [master.skus[0].sku_code] }, timeoutMs: 20_000 });
    const stock = (result.payload as Array<{ sku_code: string; stock_num: number }>).find(row => row.sku_code === master.skus[0].sku_code);
    assert.equal(Number(stock?.stock_num), expectedQty);
    branches.push({ shop: shop.shop_name, visible: product?.isDisplay ?? false, barcode: product?.spuNo,
      price: product?.skus[0]?.price, qty: Number(stock?.stock_num), itemId: product?.itemId });
  }
  const { data: queue, error: queueError } = await db.from("youzan_stock_sync_queue").select("shop_id,status,last_error").eq("sku_id", skuId);
  if (queueError) throw queueError;
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), sku, stocks, branches, queue }));
}
