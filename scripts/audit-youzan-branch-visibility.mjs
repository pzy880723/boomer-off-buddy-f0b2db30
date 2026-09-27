// Read-only: DB GETs plus the single allowlisted Youzan detail query. No token refresh/writes.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const AFFECTED_SKUS = [
  '18ace324-fbd1-4c8e-8dcd-12f01329a99e', 'fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3',
  'de4e0f1b-0008-4942-bb61-87a8110a2f38', '011be6aa-7d8a-468e-90f2-1716b988528e',
  '985fc80d-b756-4730-81f2-90d15371eb54', 'ff31f0b5-56f9-4a74-a758-ea2ce71caef4',
  '93e6d91f-b026-4c1d-8b45-fd44bab8dca3', 'a63bfb74-550d-4f4d-a893-23125414945e',
  'b3fb80a7-89cc-4cd7-b4e2-f1a85c5640ca', '94fe48f4-84c2-4ff2-96f4-3723ebd6ce1d',
];
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const positiveId = value => value !== null && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const numeric = value => value !== null && value !== undefined && value !== '' && ['number', 'string'].includes(typeof value) && Number.isFinite(Number(value));
export function normalizeVisibilityDetail(payload, kdt, code) {
  const row = payload?.data ?? payload;
  if (!row || Number(row.kdt_id) !== Number(kdt) || Number(row.channel) !== 1 || row.item_code !== code
    || !positiveId(row.item_id) || !positiveId(row.channel_item_id) || !numeric(row.display)
    || ![0, 1].includes(Number(row.display)) || !numeric(row.sold_num) || !Array.isArray(row.skus) || !row.skus.length)
    throw Error('detail_identity_or_fields_invalid');
  const skus = row.skus.map(s => {
    if (!positiveId(s.sku_id) || !positiveId(s.channel_sku_id) || !numeric(s.price)) throw Error('detail_sku_fields_invalid');
    if ((s.stock_num_str !== undefined || s.stock_num !== undefined) && !numeric(s.stock_num_str ?? s.stock_num))
      throw Error('detail_stock_invalid');
    return { sku_id: Number(s.sku_id), channel_sku_id: Number(s.channel_sku_id),
      sku_barcode: s.sku_barcode ?? null, price: Number(s.price),
      ...(numeric(s.stock_num_str ?? s.stock_num) ? { stock: s.stock_num_str != null ? Number(s.stock_num_str) : Number(s.stock_num) / 1000 } : {}) };
  }).sort((a, b) => a.channel_sku_id - b.channel_sku_id);
  if (new Set(skus.map(s => s.channel_sku_id)).size !== skus.length) throw Error('duplicate_sku_identity');
  return { kdt_id: Number(kdt), state: 'present', item_code: code, item_id: Number(row.item_id),
    channel_item_id: Number(row.channel_item_id), display: Number(row.display), sold_num: Number(row.sold_num),
    item_barcode: row.item_barcode ?? '', skus };
}

export async function auditBranchVisibility({ audit, skuIds, shops, hqId, readDetail }) {
  if (!Array.isArray(skuIds) || !skuIds.length || skuIds.length > 13 || skuIds.some(id => !uuid.test(id))
    || new Set(skuIds).size !== skuIds.length) throw Error('Require 1..13 distinct explicit SKU UUIDs');
  if (!shops.length || shops.length * skuIds.length > 200 || shops.some(s => !positiveId(s.kdt_id))
    || new Set(shops.map(s => Number(s.kdt_id))).size !== shops.length) throw Error('Invalid or excessive active branch scope');
  // Validate the entire scope before any remote product query.
  const selected = skuIds.map(id => {
    const rows = audit.filter(row => row.sku?.id === id || row.id === id);
    const row = rows[0];
    if (rows.length !== 1 || row.error || !positiveId(row.master?.spu_id) || !row.master?.spu_code
      || !row.links?.some(link => link.shop_id === hqId && Number(link.yz_item_id) === Number(row.master.spu_id))
      || !row.branches?.length || row.branches.some(b => !positiveId(b.kdt))) throw Error(`Incomplete baseline identity: ${id}`);
    if (row.branches.some(b => !shops.some(s => Number(s.kdt_id) === Number(b.kdt)))) throw Error(`Target branch not active: ${id}`);
    return row;
  });
  const products = []; let ok = true;
  for (const row of selected) {
    const product = { sku_id: row.sku.id, master_code: row.master.spu_code,
      target_kdts: [...new Set(row.branches.map(b => Number(b.kdt)))].sort(), branches: [] };
    for (const shop of shops) {
      let branch;
      try {
        const response = await readDetail(Number(shop.kdt_id), row.master.spu_code);
        branch = response.state === 'absent' ? { kdt_id: Number(shop.kdt_id), state: 'absent' }
          : normalizeVisibilityDetail(response.detail, shop.kdt_id, row.master.spu_code);
      } catch {
        // Never include raw upstream bodies, URLs or credentials in artifacts.
        branch = { kdt_id: Number(shop.kdt_id), state: 'error', error: 'detail_read_failed_or_identity_unverified' };
        ok = false;
      }
      if (product.target_kdts.includes(Number(shop.kdt_id))) {
        if (branch.state !== 'present') ok = false;
      } else if (branch.state === 'present' && branch.display === 1) {
        branch.unexpected_visibility = true; ok = false;
      }
      product.branches.push(branch);
    }
    products.push(product);
  }
  return { schema: 'youzan-branch-visibility-v1', generated_at: new Date().toISOString(), ok,
    scope: skuIds, shops: shops.map(({ id, shop_name, kdt_id }) => ({ id, shop_name, kdt_id: Number(kdt_id) })),
    request_count: shops.length * skuIds.length, products };
}

export async function readBranchDetail(fetchImpl, token, kdt, code) {
  const response = await fetchImpl(`https://open.youzanyun.com/api/youzan.item.itemdetail.get/1.0.0?access_token=${encodeURIComponent(token)}`, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: { kdt_id: kdt, item_code: code, channel: 1 } }), signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  const codeValue = Number(body.error_response?.code ?? body.code);
  if (response.ok && [121001008, 122001001].includes(codeValue)) return { state: 'absent' };
  if (!response.ok || body.success === false || body.error_response || (body.code !== undefined && Number(body.code) !== 200))
    throw Error('youzan_detail_read_failed');
  return { state: 'present', detail: body.data ?? body.response ?? body };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node --env-file=.env scripts/audit-youzan-branch-visibility.mjs --audit BEFORE.jsonl --affected10\nOr --sku UUID (repeat, max 13). JSON report to stdout. GET DB; detail-only Youzan POST.'); return;
  }
  let file; let skuIds = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--audit') file = args[++i];
    else if (args[i] === '--sku') skuIds.push(args[++i]);
    else if (args[i] === '--affected10') skuIds.push(...AFFECTED_SKUS);
    else throw Error('Unknown argument; use --help');
  }
  if (!file || !skuIds.length || skuIds.length > 13 || skuIds.some(id => !uuid.test(id))) throw Error('Require --audit and explicit --sku/--affected10');
  const text = (await readFile(file, 'utf8')).trim();
  const audit = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).map(line => JSON.parse(line));
  if (!Array.isArray(audit)) throw Error('Expected audit JSONL or array');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origin = process.env.SUPABASE_URL;
  if (!key || !origin) throw Error('Protected SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  async function db(path) {
    const response = await fetch(`${origin.replace(/\/$/, '')}/rest/v1/${path}`, { redirect: 'error',
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`Database read HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length >= 1000) throw Error('Incomplete database scope');
    return rows;
  }
  const hqs = await db('youzan_shops?select=id,access_token&role=eq.hq&status=eq.active');
  if (hqs.length !== 1 || !hqs[0].access_token) throw Error('Require one active HQ with existing token');
  const shops = await db('youzan_shops?select=id,shop_name,kdt_id&role=eq.branch&status=eq.active&order=id');
  const result = await auditBranchVisibility({ audit, skuIds, shops, hqId: hqs[0].id,
    readDetail: (kdt, code) => readBranchDetail(fetch, hqs[0].access_token, kdt, code) });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Readonly audit failed before complete report; check arguments, input and protected environment. No credentials or upstream bodies logged.'); process.exitCode = 1; });
}
