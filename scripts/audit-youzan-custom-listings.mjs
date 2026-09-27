// Read-only audit. Run on the fixed-egress host with its protected environment.
const ids = process.argv.slice(2);
if (!ids.length || ids.some(id => !/^[0-9a-f-]{36}$/.test(id))) throw new Error("Pass explicit SKU UUIDs");
async function db(path) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Database read failed: ${res.status}`);
  return res.json();
}
const shops = await db("youzan_shops?select=id,shop_name,kdt_id,role,access_token,warehouse_code");
const hq = shops.find(s => s.role === "hq");
const locations = await db("inv_locations?select=id,name,shop_id");
async function api(method, params, version = "3.0.0") {
  const res = await fetch(`https://open.youzanyun.com/api/${method}/${version}?access_token=${encodeURIComponent(hq.access_token)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(30000),
  });
  const body = await res.json();
  if (!res.ok || body.success === false || body.error_response || (body.code && body.code !== 200)) {
    throw new Error(JSON.stringify(body));
  }
  return body.data ?? body.response ?? body;
}
const masters = new Map();
let masterPage = 1;
let mastersExhausted = false;
async function masterById(id) {
  // This API can ignore spu_ids; verify identity and paginate rather than choosing row 0.
  while (!masters.has(id) && !mastersExhausted && masterPage <= 100) {
    const result = await api("youzan.retail.open.spu.query", { page_no: masterPage++, page_size: 20 });
    const rows = result.spus ?? [];
    for (const row of rows) masters.set(Number(row.spu_id), row);
    mastersExhausted = rows.length < 20;
  }
  return masters.get(id);
}
for (const id of ids) {
  try {
    const [sku] = await db(`inv_skus?id=eq.${id}&select=id,name,barcode,price_tier,image_paths,image_processing_status`);
    const stocks = await db(`inv_stocks?sku_id=eq.${id}&select=location_id,qty`);
    const links = await db(`sku_youzan_links?sku_id=eq.${id}&select=shop_id,yz_item_id,yz_sku_id,status,last_error`);
    const hqLink = links.find(l => l.shop_id === hq.id);
    if (!hqLink) throw new Error("No HQ link");
    const master = await masterById(Number(hqLink.yz_item_id));
    if (!master) throw new Error("No HQ product");
    const hqDetail = await api("youzan.item.itemdetail.get", { request: { kdt_id: Number(hq.kdt_id), item_code: master.spu_code, channel: 0 } }, "1.0.0");
    const branches = [];
    for (const stock of stocks) {
      const location = locations.find(l => l.id === stock.location_id);
      const shop = shops.find(s => s.id === location?.shop_id);
      if (!shop || shop.role === "hq") continue;
      const detail = await api("youzan.item.itemdetail.get", { request: { kdt_id: Number(shop.kdt_id), item_code: master.spu_code, channel: 1 } }, "1.0.0");
      const warehouse = await api("youzan.retail.open.query.warehousestock", { warehouse_code: shop.warehouse_code, sku_codes: master.skus.map(s => s.sku_code) }, "1.0.0");
      branches.push({ name: location.name, erpQty: stock.qty, kdt: shop.kdt_id, warehouse, detail });
    }
    console.log(JSON.stringify({ sku, links, master, hqDetail, branches }));
  } catch (error) { console.log(JSON.stringify({ id, error: error.message })); process.exitCode = 1; }
}
