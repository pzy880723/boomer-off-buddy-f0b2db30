// Trusted-server, read-only canary. Never creates or signs for a synthetic transfer.
import assert from "node:assert/strict";
import sharp from "sharp";
import { supabaseAdmin as db } from "../src/integrations/supabase/client.server";
import { executeCustomTransfer } from "../src/server/custom-transfers.server";
import { signProductItems } from "../src/server/handheld-products.server";

async function main() {
  const base = process.argv[2];
  assert.ok(["https://erp.boomeroff.com", "http://127.0.0.1:3006"].includes(base));
  const transferID = "f90555b1-a7d3-4273-bfa3-41cc7d26c176";
  const {data:t,error} = await (db as any).from("stock_transfers").select("id,received_by,from_location_id,to_location_id,status,qty").eq("id",transferID).single();
  assert.ifError(error); assert.equal(t.qty,5); assert.equal(t.status,"received");
  const detail = await executeCustomTransfer(t.received_by,{action:"detail",id:t.id,location_id:t.from_location_id});
  assert.equal(detail.transfer?.can_receive,false);
  assert.ok(detail.transfer?.photos.length);
  await assert.rejects(executeCustomTransfer(t.received_by,{action:"upload",id:t.id,location_id:t.from_location_id,image_base64:"invalid"}), (e:any)=>e.code==="transfer_receive_forbidden");
  const {data:sku,error:skuError} = await (db as any).from("inv_skus").select("id,image_paths,image_url").eq("id","afaa0229-e7ab-4685-87f0-83a9237aad0b").single();
  assert.ifError(skuError);
  const [product] = await signProductItems([sku]);
  assert.equal(product.images.length,2);
  const urls = [
    ...detail.transfer!.photos.flatMap(p=>[p.thumbnail_url!,p.url]),
    product.image_url!, ...product.images.map(i=>i.read_url),
  ];
  for (const [index,value] of urls.entries()) {
    const url = new URL(value); assert.equal(url.origin,"https://erp.boomeroff.com");
    const target = base+url.pathname+url.search;
    for (let attempt=0;attempt<2;attempt++) {
      const start=Date.now();const r=await fetch(target,{signal:AbortSignal.timeout(25000)});
      assert.equal(r.status,200); const bytes=Buffer.from(await r.arrayBuffer());
      const meta=await sharp(bytes).metadata(); assert.ok(meta.width && meta.height);
      assert.ok(meta.width!<=Number(url.searchParams.get("width")));
      console.log(JSON.stringify({image:index,attempt,bytes:bytes.length,width:meta.width,height:meta.height,elapsed_ms:Date.now()-start}));
    }
  }
  const privateURL=new URL(detail.transfer!.photos[0].url);privateURL.searchParams.delete("signature");
  assert.equal((await fetch(base+privateURL.pathname+privateURL.search)).status,403);
  const {data:lines} = await (db as any).from("stock_transfer_lines").select("sku_id").eq("transfer_id",t.id);
  const {data:stocks,error:stockError} = await (db as any).from("inv_stocks").select("sku_id,location_id,qty").in("sku_id",lines.map((l:any)=>l.sku_id)).gt("qty",0);
  assert.ifError(stockError);assert.ok(stocks.every((s:any)=>s.location_id===t.to_location_id));
  console.log(JSON.stringify({base,transfer:t.id,status:t.status,qty:t.qty,positiveStockRows:stocks.length,onlyDestinationStock:true,mutations:0}));
}
main().catch(e=>{console.error(e.name, e.code ?? "verification_failed");process.exitCode=1;});
