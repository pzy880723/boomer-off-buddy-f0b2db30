import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const source = readFileSync(new URL('../youzan.functions.ts', import.meta.url), 'utf8');
function compile(start, end, globals, expression) {
  const code = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return vm.runInNewContext(`${stripTypeScriptTypes(code.replaceAll('export ', ''))}\n${expression}`, globals);
}
function parser() {
  return compile('async function parseYouzanVerboseResponse(', 'export async function callYouzanApiVerbose(', {
    formatYouzanIpError: String,
  }, 'parseYouzanVerboseResponse');
}
test('HTTP failure cannot be a successful empty payload', async () => {
  await assert.rejects(() => parser()(new Response('{}', { status: 500 })), /HTTP|http/);
});

function runner(responses, { failWrite = false } = {}) {
  const calls = [];
  const writes = [];
  const accepted = [];
  const supabase = { from(table) {
    if (table === 'youzan_sync_logs') return {
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'log' } }) }) }),
      update: () => ({ eq: async () => ({}) }),
    };
    if (table === 'youzan_shops') return { select: () => ({ eq: async () => ({ data: [{ id: 'shop', kdt_id: 7 }] }) }) };
    if (table === 'youzan_orders') return { upsert: async (rows) => {
      writes.push(...rows);
      return { error: failWrite ? new Error('write_failed') : null };
    } };
    throw Error(table);
  } };
  const globals = {
    Date, Map, Set, Number, String, JSON, Error, console, supabase,
    getHqShop: async () => ({}), ensureAccessToken: async () => 'test-token',
    createSupabaseYouzanSaleAdapter: () => ({}),
    extractYouzanSale: () => ({ sourceChannel: 'youzan_offline', targetKdtId: 7 }),
    isYouzanSaleStatus: () => true,
    processYouzanSale: async () => { accepted.push('inventory'); return { processed: 1, idempotent: 0, unmatched: 0, failed: 0 }; },
    yzStatusText: String,
    callYouzanApiVerbose: async ({ version, params }) => {
      calls.push({ version, params });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { payload: next, preview: '', trace_id: null };
    },
  };
  const run = compile('function pickTradeRows(', '/**\n * 有界切片订单同步', globals, 'runOrdersSyncForShop');
  return { run, writes, calls, accepted };
}
const order = { tid: 'order-1', payment: 10, status: 'TRADE_SUCCESS', modified: '2026-09-07 12:00:00', pay_time: '2026-09-07 11:00:00' };
const shop = { id: 'shop', kdt_id: 7, role: 'branch' };
const start = new Date('2026-09-07T00:00:00Z');
const end = new Date('2026-09-07T04:30:00Z');
test('empty successful version cannot mask nonempty version write failure', async () => {
  const r = runner([{ trades: [] }, { trades: [order] }], { failWrite: true });
  const result = await r.run(shop, start, end, { startPage: 1, maxPages: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.next_page, 1);
});
test('queue rejects unknown payload instead of treating it as empty', async () => {
  const r = runner([{}, {}, {}]);
  const result = await r.run(shop, start, end, { startPage: 1, maxPages: 2, commitRows: async () => [] });
  assert.equal(result.ok, false);
});
test('queue rejected fenced commit cannot write orders or reconcile inventory', async () => {
  const r = runner([{ trades: [order] }]);
  const result = await r.run(shop, start, end, {
    startPage: 1, maxPages: 2,
    commitRows: async () => { throw Error('lease_lost'); },
  });
  assert.equal(result.ok, false);
  assert.equal(r.writes.length, 0);
  assert.equal(r.accepted.length, 0);
});
test('queue passes source version and timezone-correct bounds to fenced path', async () => {
  const r = runner([{ trades: [order] }]);
  let rows;
  const result = await r.run(shop, start, end, {
    startPage: 1, maxPages: 2,
    commitRows: async (batch) => { rows = batch; return batch.map(row => `${row.kdt_id}:${row.tid}`); },
  });
  assert.equal(result.ok, true);
  assert.equal(r.writes.length, 0);
  assert.equal(rows?.[0].source_updated_at, '2026-09-07T04:00:00.000Z');
  assert.equal(r.calls[0].params.start_update, '2026-09-07 08:00:00');
  assert.equal(r.calls[0].params.end_update, '2026-09-07 12:30:00');
  assert.equal(r.accepted.length, 1);
});
test('manual successful sync retains its existing write and inventory path', async () => {
  const r = runner([{ trades: [order] }]);
  const result = await r.run(shop, start, end);
  assert.equal(result.ok, true);
  assert.equal(r.writes.length, 1);
  assert.equal(r.accepted.length, 1);
});
test('queue malformed nonempty order cannot be dropped into completed empty scan', async () => {
  const r = runner([{ trades: [{payment:10}] }]);
  const result = await r.run(shop,start,end,{startPage:1,maxPages:2,commitRows:async()=>[]});
  assert.equal(result.ok,false);
  assert.equal(result.next_page,1);
});
test('queue mid-slice failure keeps start page for safe idempotent replay', async () => {
  const rows=Array.from({length:20},(_,i)=>({...order,tid:`t${i}`}));
  const r=runner([{trades:rows},Error('page_two_failed')]);
  const result=await r.run(shop,start,end,{startPage:4,maxPages:2,commitRows:async batch=>batch.map(row=>`${row.kdt_id}:${row.tid}`)});
  assert.equal(result.ok,false);
  assert.equal(result.next_page,4);
  assert.equal(r.writes.length,0);
});
test('queue maxPages preserves continuation and pins successful API version', async () => {
  const rows=Array.from({length:20},(_,i)=>({...order,tid:`t${i}`}));
  const r=runner([{trades:rows}]);
  const result=await r.run(shop,start,end,{startPage:4,maxPages:1,methodLabel:'trades.sold.get@4.0.2',commitRows:async batch=>batch.map(row=>`${row.kdt_id}:${row.tid}`)});
  assert.equal(result.ok,true);
  assert.equal(result.next_page,5);
  assert.equal(result.method_label,'trades.sold.get@4.0.2');
  assert.equal(r.calls.length,1);
});
test('bounded queue slices never turn the legacy page-500 cap into false completion',async()=>{
  const rows=Array.from({length:20},(_,i)=>({...order,tid:`t${i}`}));
  const r=runner([{trades:rows},{trades:rows}]);
  const result=await r.run(shop,start,end,{startPage:501,maxPages:2,commitRows:async batch=>batch.map(row=>`${row.kdt_id}:${row.tid}`)});
  assert.equal(result.ok,true);
  assert.equal(result.next_page,503);
  assert.equal(r.calls.length,2);
});
