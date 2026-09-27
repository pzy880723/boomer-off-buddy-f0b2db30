// Offline comparison only. This module never opens a network connection.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AFFECTED_SKUS, normalizeVisibilityDetail } from './audit-youzan-branch-visibility.mjs';

const REPAIRS = {
  '18ace324-fbd1-4c8e-8dcd-12f01329a99e': { code: 'BM529821940370', barcode: '2006890664290', price: 399, oldBarcode: 'P260927306036196' },
  'fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3': { code: 'BM645119936025', barcode: '2000128424847', price: 299 },
};
const TARGET_KDT = 212291308;
const requireValue = (condition, message) => { if (!condition) throw Error(message); };
const number = (value, label) => {
  requireValue(value !== null && value !== undefined && value !== '' && ['number', 'string'].includes(typeof value)
    && Number.isFinite(Number(value)), `Missing/invalid ${label}`);
  return Number(value);
};
const sorted = items => [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const same = (before, after, label) => requireValue(JSON.stringify(before) === JSON.stringify(after), `${label} changed`);
function keyed(rows, key, label) {
  requireValue(Array.isArray(rows), `${label} must be an array`);
  const map = new Map();
  for (const row of rows) {
    const id = key(row);
    requireValue(id !== undefined && id !== null && id !== '' && !map.has(String(id)), `${label} missing/duplicate identity`);
    map.set(String(id), row);
  }
  return map;
}
function matching(before, after, label) { same([...before.keys()].sort(), [...after.keys()].sort(), `${label} coverage`); }
export function parseAudit(text) {
  requireValue(text.trim(), 'Empty audit');
  const rows = text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split(/\r?\n/).map(line => JSON.parse(line));
  requireValue(Array.isArray(rows) && rows.length && rows.every(row => row && typeof row === 'object' && !Array.isArray(row)), 'Invalid audit rows');
  return rows;
}
function allowedBarcode(id, before, after, kdt) {
  return id === Object.keys(REPAIRS)[0] && Number(kdt) === TARGET_KDT
    && before === REPAIRS[id].oldBarcode && after === REPAIRS[id].barcode;
}
function compareBarcode(id, before, after, kdt, label, changes) {
  if (before === after) return;
  requireValue(allowedBarcode(id, before, after, kdt), `${label} barcode changed unexpectedly`);
  changes.push({ sku_id: id, kdt, field: label, before, after });
}
function compareDetail(id, before, after, kdt, label, changes) {
  const a = structuredClone(before), b = structuredClone(after);
  compareBarcode(id, a.item_barcode, b.item_barcode, kdt, `${label}.item_barcode`, changes);
  a.item_barcode = b.item_barcode;
  const aa = keyed(a.skus, s => s.channel_sku_id, label), bb = keyed(b.skus, s => s.channel_sku_id, label);
  matching(aa, bb, `${label} SKU`);
  for (const [key, sku] of aa) {
    const other = bb.get(key);
    compareBarcode(id, sku.sku_barcode, other.sku_barcode, kdt, `${label}.sku_barcode`, changes);
    sku.sku_barcode = other.sku_barcode;
    if (REPAIRS[id] && Number(kdt) === TARGET_KDT && sku.stock === 0 && other.stock === 1) sku.stock = 1;
  }
  // Sort by stable identity, not the upstream array order.
  a.skus = [...aa.values()].sort((x, y) => x.channel_sku_id - y.channel_sku_id);
  b.skus = [...bb.values()].sort((x, y) => x.channel_sku_id - y.channel_sku_id);
  same(a, b, label);
}
function warehouseRows(branch) {
  const payload = branch.warehouse?.data ?? branch.warehouse;
  requireValue(Array.isArray(payload) && payload.length, 'Missing warehouse evidence');
  return keyed(payload, row => row.sku_code, 'warehouse SKU');
}
function warehouseQuantity(row, field) {
  // WMS uses whole units; only itemdetail's raw stock_num is thousandths.
  return number(row[`${field}_str`] ?? row[field], `warehouse.${field}`);
}
function hqFields(payload) {
  const row = payload?.data ?? payload;
  requireValue(row && Number(row.channel) === 0 && row.item_code && row.item_id && row.kdt_id && Array.isArray(row.skus), 'Invalid HQ detail identity');
  return { item_id: row.item_id, item_code: row.item_code, kdt_id: row.kdt_id, display: row.display,
    item_barcode: row.item_barcode, skus: sorted(row.skus.map(s => ({ sku_id: s.sku_id,
      sku_barcode: s.sku_barcode ?? null, price: number(s.price, 'HQ SKU price') }))) };
}

export function compareRepairAudits(beforeRows, afterRows) {
  const errors = [], warnings = [], expected_stock_changes = [], expected_barcode_changes = [], products = [];
  let before, after;
  try {
    before = keyed(beforeRows, row => row.sku?.id ?? row.id, 'before');
    after = keyed(afterRows, row => row.sku?.id ?? row.id, 'after');
    matching(before, after, 'product');
    for (const id of Object.keys(REPAIRS)) requireValue(before.has(id), `Expected repair SKU missing: ${id}`);
  } catch (error) { return { ok: false, errors: [error.message], warnings, expected_stock_changes, expected_barcode_changes, products }; }
  for (const [id, a] of before) {
    const b = after.get(id);
    try {
      requireValue(!a.error && !b.error, `Audit read failed for ${id}`);
      same(a.sku.barcode, b.sku.barcode, 'ERP barcode');
      same(number(a.sku.price_tier, 'ERP price'), number(b.sku.price_tier, 'ERP price'), 'ERP price');
      requireValue(a.sku.barcode && b.sku.barcode, 'ERP barcode missing');
      same(a.master?.spu_id, b.master?.spu_id, 'HQ SPU ID');
      same(a.master?.spu_code, b.master?.spu_code, 'HQ SPU code');
      requireValue(a.master?.spu_id && a.master?.spu_code, 'Master identity missing');
      if (a.master.retail_price !== undefined || b.master.retail_price !== undefined)
        same(number(a.master.retail_price, 'master price'), number(b.master.retail_price, 'master price'), 'Master retail price');
      const codes = master => [...keyed(master.skus, sku => sku.sku_code, 'master SKUs').keys()].sort();
      same(codes(a.master), codes(b.master), 'Master SKU codes');
      const masterFields = master => sorted(master.skus.map(s => ({ sku_id: s.sku_id, sku_code: s.sku_code,
        sku_no: s.sku_no, retail_price: s.retail_price === undefined ? null : number(s.retail_price, 'master SKU price') })));
      same(masterFields(a.master), masterFields(b.master), 'Master SKU identity/price/barcode');
      same(a.master.spu_no, b.master.spu_no, 'Master barcode');
      if (REPAIRS[id]) {
        same(b.master.spu_code, REPAIRS[id].code, 'Pinned repair master code');
        same(b.sku.barcode, REPAIRS[id].barcode, 'Pinned repair barcode');
        same(number(b.sku.price_tier, 'repair price'), REPAIRS[id].price, 'Pinned repair price');
      }
      const branchesA = keyed(a.branches, r => r.kdt, 'before branches'), branchesB = keyed(b.branches, r => r.kdt, 'after branches');
      requireValue(branchesA.size > 0, 'Missing target branch evidence');
      matching(branchesA, branchesB, 'branch');
      for (const [kdt, branchA] of branchesA) {
        const branchB = branchesB.get(kdt);
        same(number(branchA.erpQty, 'ERP quantity'), number(branchB.erpQty, 'ERP quantity'), 'ERP stock');
        const detailA = normalizeVisibilityDetail(branchA.detail, kdt, a.master.spu_code);
        const detailB = normalizeVisibilityDetail(branchB.detail, kdt, b.master.spu_code);
        compareDetail(id, detailA, detailB, kdt, `branch ${kdt}`, expected_barcode_changes);
        same(detailB.item_barcode, b.sku.barcode, 'Final POS barcode vs ERP');
        for (const sku of detailB.skus) same(sku.price, Math.round(Number(b.sku.price_tier) * 100), 'Final POS price (cents) vs ERP');
        const wa = warehouseRows(branchA), wb = warehouseRows(branchB);
        matching(wa, wb, 'warehouse'); same([...wb.keys()].sort(), codes(b.master), 'Warehouse vs master SKU codes');
        for (const [code, stockA] of wa) {
          const stockB = wb.get(code), oldQty = warehouseQuantity(stockA, 'stock_num'), qty = warehouseQuantity(stockB, 'stock_num');
          same(warehouseQuantity(stockA, 'freeze_num'), warehouseQuantity(stockB, 'freeze_num'), 'Warehouse reserved quantity');
          for (const field of ['plan_num', 'plan_freeze_num', 'road_num']) {
            if (stockA[field] !== undefined || stockB[field] !== undefined)
              same(warehouseQuantity(stockA, field), warehouseQuantity(stockB, field), `Warehouse ${field}`);
          }
          if (stockA.warehouse_code !== undefined || stockB.warehouse_code !== undefined)
            same(stockA.warehouse_code, stockB.warehouse_code, 'Warehouse identity');
          if (REPAIRS[id] && Number(kdt) === TARGET_KDT) {
            same(oldQty, 0, 'Expected repair before stock'); same(qty, 1, 'Expected repair after stock');
            same(Number(branchB.erpQty), 1, 'Repair ERP stock'); same(warehouseQuantity(stockB, 'freeze_num'), 0, 'Repair reserved stock');
            same(detailB.sold_num, 0, 'Repair sold quantity');
            expected_stock_changes.push({ sku_id: id, kdt: Number(kdt), sku_code: code, before: oldQty, after: qty });
          } else same(oldQty, qty, `Unapproved WMS stock ${id}/${kdt}/${code}`);
        }
      }
      if (a.hqDetail && b.hqDetail) same(hqFields(a.hqDetail), hqFields(b.hqDetail), 'HQ detail price/barcode/visibility');
      else if (a.hqDetail) throw Error('Final HQ detail missing');
      else warnings.push({ sku_id: id, code: 'HQ_BEFORE_UNAVAILABLE', message: 'before-v2 has no HQ detail; HQ before/after invariance is NOT established' });
      products.push({ sku_id: id, ok: true, branches_checked: branchesA.size });
    } catch (error) { errors.push({ sku_id: id, message: error.message }); products.push({ sku_id: id, ok: false }); }
  }
  if (expected_stock_changes.length !== 2) errors.push({ message: 'Require exactly two approved WMS 0->1 changes' });
  return { ok: errors.length === 0, scope: [...before.keys()], errors, warnings, expected_stock_changes, expected_barcode_changes, products };
}

export function compareBranchAudits(before, after) {
  const errors = [], expected_barcode_changes = [], expected_channel_removals = [], warnings = [];
  try {
    requireValue(before?.schema === 'youzan-branch-visibility-v1' && after?.schema === before.schema, 'Invalid visibility audit schema');
    requireValue(after.ok === true, 'Final visibility audit incomplete or exclusivity failed');
    same([...before.scope].sort(), [...after.scope].sort(), 'Visibility SKU scope');
    const sa = keyed(before.shops, s => s.kdt_id, 'before shops'), sb = keyed(after.shops, s => s.kdt_id, 'after shops');
    matching(sa, sb, 'active shops');
    const pa = keyed(before.products, p => p.sku_id, 'before products'), pb = keyed(after.products, p => p.sku_id, 'after products');
    matching(pa, pb, 'visibility products'); same([...pa.keys()].sort(), [...before.scope].sort(), 'Declared visibility scope');
    for (const [id, a] of pa) {
      const b = pb.get(id); same(a.master_code, b.master_code, 'Visibility master code');
      same([...a.target_kdts].sort(), [...b.target_kdts].sort(), 'Target store scope');
      same(b.target_kdts, [TARGET_KDT], 'Final exclusive Xintiandi target');
      const ba = keyed(a.branches, r => r.kdt_id, 'before visibility'), bb = keyed(b.branches, r => r.kdt_id, 'after visibility');
      matching(ba, sa, 'before all branches'); matching(bb, sb, 'after all branches');
      for (const [kdt, old] of ba) {
        const current = bb.get(kdt);
        requireValue(['present', 'absent'].includes(old.state) && ['present', 'absent'].includes(current.state), 'Unknown visibility result');
        if (id === 'fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3' && Number(kdt) !== TARGET_KDT
          && old.state === 'present' && current.state === 'absent') {
          same(a.master_code, REPAIRS[id].code, 'KORG cleanup master code');
          expected_channel_removals.push({ sku_id: id, kdt: Number(kdt), before: 'present', after: 'absent',
            quantity_price_after: 'not_observable_after_channel_removal' });
          continue;
        }
        same(old.state, current.state, `Presence ${id}/${kdt}`);
        if (Number(kdt) !== TARGET_KDT) requireValue(current.state === 'absent', `Other-store product still exists ${id}/${kdt}`);
        else requireValue(current.state === 'present' && current.display === 1, `Xintiandi product not visible ${id}`);
        if (current.state === 'present') {
          const previous = structuredClone(old), latest = structuredClone(current);
          // First scope-check version did not collect channel stock. Never invent a baseline.
          if (previous.skus.some(s => s.stock === undefined)) {
            warnings.push({ sku_id: id, kdt: Number(kdt), code: 'CHANNEL_STOCK_BASELINE_UNAVAILABLE' });
            for (const sku of previous.skus) delete sku.stock;
            for (const sku of latest.skus) delete sku.stock;
          }
          compareDetail(id, previous, latest, kdt, `Visibility ${id}/${kdt}`, expected_barcode_changes);
        }
      }
    }
    if (before.ok !== true) requireValue(expected_channel_removals.length > 0, 'Unexplained failed scope check');
  } catch (error) { errors.push(error.message); }
  return { ok: errors.length === 0, baseline_kind: 'in_progress_scope_check', errors, warnings,
    expected_barcode_changes, expected_channel_removals };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('node scripts/verify-youzan-repair-audit.mjs BEFORE.jsonl AFTER.jsonl [--branches-before BEFORE.json --branches-after AFTER.json]\nJSON to stdout, exit1 on discrepancy, exit2 on invalid input. No network.'); return; }
  const [beforeFile, afterFile, ...options] = args;
  requireValue(beforeFile && afterFile, 'Supply before and after audit files');
  let branchBefore, branchAfter;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === '--branches-before') branchBefore = options[++i];
    else if (options[i] === '--branches-after') branchAfter = options[++i];
    else throw Error('Unknown argument');
  }
  requireValue(Boolean(branchBefore) === Boolean(branchAfter), 'Supply both visibility files');
  const report = compareRepairAudits(parseAudit(await readFile(beforeFile, 'utf8')), parseAudit(await readFile(afterFile, 'utf8')));
  if (branchBefore) {
    const before = JSON.parse(await readFile(branchBefore, 'utf8')), after = JSON.parse(await readFile(branchAfter, 'utf8'));
    report.all_branch_visibility = compareBranchAudits(before, after);
    const missing = AFFECTED_SKUS.filter(id => !after.scope?.includes(id));
    if (missing.length) { report.all_branch_visibility.ok = false; report.all_branch_visibility.errors.push(`Missing affected10 scope: ${missing.join(',')}`); }
    report.ok &&= report.all_branch_visibility.ok;
  } else report.warnings.push({ code: 'ALL_BRANCH_BASELINE_NOT_SUPPLIED', message: 'Only baseline target branches compared; all-store invariance NOT established' });
  console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Audit comparison failed: invalid/missing input or arguments (use --help).'); process.exitCode = 2; });
}
