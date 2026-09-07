import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, after } from 'node:test';

// PGLITE_MODULE points at an isolated, pinned @electric-sql/pglite installation.
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = resolve(import.meta.dirname, '../../..');
const sql = (name) => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
const migration = sql('20260907171143_ordinary_wechat_payment.sql');
const core = sql('20260713090000_commerce_fulfillment_core.sql');
const unified = sql('20260726114338_unify_commerce_and_pos.sql');
const func = (source, name) => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert(start >= 0, `Missing real function ${name}`);
  return source.slice(start, source.indexOf('\n$$;', start) + 4);
};
const customer = '00000000-0000-0000-0000-000000000001';
const location = '00000000-0000-0000-0000-000000000002';
const sku = '00000000-0000-0000-0000-000000000003';
const listing = '00000000-0000-0000-0000-000000000004';

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE TABLE inv_locations(id uuid PRIMARY KEY, name text, kind text, is_active boolean DEFAULT true);
    CREATE TABLE inv_skus(id uuid PRIMARY KEY, name text, kind text DEFAULT 'single',
      is_custom_price boolean DEFAULT false, status text DEFAULT 'active', is_display boolean DEFAULT true,
      bundle_items jsonb DEFAULT '[]', inventory_policy text DEFAULT 'stock', stock_qty integer DEFAULT 10,
      updated_at timestamptz DEFAULT now());
    CREATE TABLE inv_stocks(sku_id uuid REFERENCES inv_skus, location_id uuid REFERENCES inv_locations,
      qty integer, updated_at timestamptz DEFAULT now(), PRIMARY KEY(sku_id,location_id));
    CREATE TABLE inv_stock_movements(id uuid DEFAULT gen_random_uuid(), sku_id uuid,location_id uuid,
      delta integer,balance_after integer,ref_type text,ref_id uuid,epc text,note text,created_by uuid);
    CREATE TABLE inv_epcs(epc text PRIMARY KEY,status text,current_location_id uuid,last_seen_at timestamptz);
    CREATE TABLE inv_handheld_devices(id uuid PRIMARY KEY);
  `);
  await db.exec(core.slice(0, core.indexOf('CREATE OR REPLACE FUNCTION public.commerce_create_order(')));
  await db.exec(sql('20260716100000_commerce_after_sales.sql'));
  await db.exec(unified.slice(0, unified.indexOf('CREATE TABLE public.pos_registers')));
  await db.exec(func(unified, 'commerce_create_order_v2'));
  await db.exec(func(unified, 'commerce_mark_order_paid'));
  await db.exec(func(core, 'commerce_release_expired_reservations'));
  await db.exec(sql('20260726153000_consumer_identity.sql'));
  await db.exec(sql('20260728120000_pos_member_discount_workflows.sql').split('CREATE TABLE public.pos_customer_wallets')[0]);
  await db.exec(`ALTER TABLE commerce_payments ADD COLUMN merchant_snapshot jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE commerce_order_items ADD COLUMN settlement_snapshot jsonb;`);
  const movement = sql('20260804181500_handheld_custom_storefront_atomic_publish.sql');
  await db.exec(func(movement, 'sync_handheld_custom_listing'));
  await db.exec(func(movement, 'inv_apply_movement'));
  await db.exec(migration);
  await db.exec(`INSERT INTO commerce_customers(id,external_subject) VALUES('${customer}','test');
    INSERT INTO inv_locations(id,name,kind) VALUES('${location}','Test store','shop');
    INSERT INTO inv_skus(id,name) VALUES('${sku}','Test vintage');
    INSERT INTO inv_stocks VALUES('${sku}','${location}',10,now());
    INSERT INTO commerce_listings(id,sku_id,location_id,title,price,status,product_type)
    VALUES('${listing}','${sku}','${location}','Test vintage',100,'published','standard');`);
  return db;
}
async function rpc(db, name, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
  return (await db.query(`SELECT to_jsonb(public.${name}(${placeholders})) AS result`, args)).rows[0].result;
}
const createArgs = (key='order-1') => [customer,key,JSON.stringify([{listing_id:listing,quantity:1}]),
  'Test','13800000000','{}','sf','express',null,0,null,null,'1749999844','wx9aef0738067286b3',[location]];
const create = (db,key) => rpc(db,'commerce_create_ordinary_order',createArgs(key));
const prepare = (db,order,key='payment-1') => rpc(db,'commerce_prepare_ordinary_payment',[order.id,customer,key,'openid-test']);
function paidEvent(payment) {
  return {event_id:'evt-pay-1',merchant_order_no:payment.merchant_order_no,merchant_id:'1749999844',
    app_id:'wx9aef0738067286b3',currency:'CNY',total_fen:10000,transaction_id:'wx-test-transaction',
    status:'succeeded',paid_at:new Date().toISOString(),payer_openid:'openid-test'};
}
let shared;
async function withDb(fn) {
  const db=await (shared ??= setup());
  // Savepoint-wrapped statements keep expected SQL errors from aborting each case.
  const isolated={
    exec: async (...args)=>{await db.exec('SAVEPOINT statement');try {return await db.exec(...args);}
      catch(error){await db.exec('ROLLBACK TO SAVEPOINT statement');throw error;}
      finally{await db.exec('RELEASE SAVEPOINT statement');}},
    query: async (...args)=>{await db.exec('SAVEPOINT statement');try {return await db.query(...args);}
      catch(error){await db.exec('ROLLBACK TO SAVEPOINT statement');throw error;}
      finally{await db.exec('RELEASE SAVEPOINT statement');}},
  };
  await db.exec('BEGIN');try{await fn(isolated);}finally{await db.exec('ROLLBACK');}
}
after(async()=>{if(shared) await (await shared).close();});

test('ordinary order captures route; old orders and unowned goods cannot be converted',()=>withDb(async db=>{
  const order=await create(db);
  assert.equal(order.payment_route.mode,'ordinary_wechat');
  assert.equal(order.payment_route.merchant_id,'1749999844');
  assert.deepEqual((await create(db)).payment_route,order.payment_route);
  await assert.rejects(db.exec(`UPDATE commerce_orders SET payment_route='{}' WHERE id='${order.id}'`),/immutable/i);
  await db.exec(`UPDATE inv_skus SET sale_ownership='vendor' WHERE id='${sku}'`);
  await assert.rejects(create(db,'other'),/owned|ownership|self.operated/i);
  await db.exec(`UPDATE inv_skus SET sale_ownership='owned' WHERE id='${sku}'`);
  const old=await rpc(db,'commerce_create_order_v2',createArgs('legacy').slice(0,12));
  await assert.rejects(create(db,'legacy'),/legacy|route/i);
  await assert.rejects(prepare(db,old),/route|ordinary/i);
}));
test('prepare binds one intent to customer, key, OpenID and leases concurrent requests',()=>withDb(async db=>{
  const order=await create(db); const first=await prepare(db,order);
  assert.equal(first.acquired,true); assert.match(first.payment.merchant_order_no,/^[a-f0-9]{32}$/);
  const second=await prepare(db,order); assert.equal(second.acquired,false);
  assert.equal(second.payment.id,first.payment.id);
  await assert.rejects(prepare(db,order,'another-key'),/idempotency|intent/i);
  await assert.rejects(rpc(db,'commerce_prepare_ordinary_payment',[order.id,customer,'payment-1','wrong-openid']),/openid/i);
  await assert.rejects(rpc(db,'commerce_prepare_ordinary_payment',[order.id,location,'payment-1','openid-test']),/customer|order/i);
}));
test('prepay CAS cannot overwrite successful payment; callbacks validate exact snapshots and are atomic',()=>withDb(async db=>{
  const order=await create(db); const {payment,lease_token}=await prepare(db,order);
  await rpc(db,'commerce_record_ordinary_prepay',[payment.id,lease_token,'prepay-test','{"nonceStr":"test"}',order.reservation_expires_at]);
  const event=paidEvent(payment);
  for(const mutation of [{total_fen:9999},{merchant_id:'wrong'},{payer_openid:'wrong'},{app_id:'wrong'}]) {
    await assert.rejects(rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify({...event,...mutation})]),/mismatch|invalid/i);
  }
  const result=await rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify(event)]);
  assert.equal(result.payment.status,'succeeded');
  assert.equal((await db.query('SELECT qty FROM inv_stocks')).rows[0].qty,9);
  assert.equal((await rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify(event)])).replayed,true);
  const late=await rpc(db,'commerce_record_ordinary_prepay',[payment.id,lease_token,'prepay-test','{}',order.reservation_expires_at]);
  assert.equal(late.status,'succeeded');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM inv_stock_movements')).rows[0].n,1);
}));
test('unknown payment holds stock through expiry; signed close releases; zero-line payment rolls back',()=>withDb(async db=>{
  const order=await create(db); const {payment}=await prepare(db,order); const event=paidEvent(payment);
  await db.exec(`UPDATE commerce_orders SET reservation_expires_at=now()-interval '1 second' WHERE id='${order.id}'`);
  await rpc(db,'commerce_release_expired_reservations',[]);
  assert.equal((await db.query(`SELECT order_status FROM commerce_orders WHERE id='${order.id}'`)).rows[0].order_status,'pending_payment');
  assert.equal((await db.query(`SELECT expires_at::text FROM inventory_reservations WHERE order_id='${order.id}'`)).rows[0].expires_at,'infinity');
  await db.exec(`UPDATE commerce_orders SET reservation_expires_at=now()+interval '1 minute' WHERE id='${order.id}'; DELETE FROM inventory_reservation_lines`);
  await assert.rejects(rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify(event)]),/inventory|reservation/i);
  assert.equal((await db.query('SELECT status FROM commerce_payments')).rows[0].status,'processing');
  await assert.rejects(rpc(db,'commerce_close_ordinary_payment',[payment.id,JSON.stringify({merchant_order_no:payment.merchant_order_no,merchant_id:'wrong',status:'CLOSED'})]),/mismatch/i);
  await rpc(db,'commerce_close_ordinary_payment',[payment.id,JSON.stringify({merchant_order_no:payment.merchant_order_no,merchant_id:'1749999844',status:'CLOSED'})]);
  assert.equal((await db.query('SELECT status FROM commerce_payments')).rows[0].status,'cancelled');
  assert.equal((await db.query('SELECT status FROM inventory_reservations')).rows[0].status,'released');
}));
test('refund reservation is idempotent, cumulative capped and success never restores physical stock',()=>withDb(async db=>{
  const order=await create(db); const {payment}=await prepare(db,order);
  await rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify(paidEvent(payment))]);
  const item=(await db.query('SELECT id FROM commerce_order_items')).rows[0].id;
  const after=(await db.query(`INSERT INTO commerce_after_sales(order_id,order_item_id,location_id,user_id,type,status,reason_code,requested_amount,approved_amount)
    VALUES($1,$2,$3,$4,'refund_only','refund_pending','test',60,60) RETURNING id`,[order.id,item,location,customer])).rows[0].id;
  const prepared=await rpc(db,'commerce_prepare_ordinary_refund',[payment.id,after,'refund-one',customer]);
  const repeated=await rpc(db,'commerce_prepare_ordinary_refund',[payment.id,after,'refund-one',customer]);
  assert.equal(prepared.refund.id,repeated.refund.id); assert.equal(repeated.acquired,false);
  const event={event_id:'evt-refund',merchant_refund_no:prepared.refund.merchant_refund_no,merchant_id:'1749999844',
    transaction_id:'wx-test-transaction',provider_refund_id:'wx-refund',status:'succeeded',total_fen:10000,refund_fen:6000,refunded_at:new Date().toISOString()};
  await rpc(db,'commerce_record_ordinary_refund',[prepared.refund.id,prepared.lease_token,'wx-refund']);
  await rpc(db,'commerce_apply_ordinary_refund',[JSON.stringify(event)]);
  assert.equal((await rpc(db,'commerce_apply_ordinary_refund',[JSON.stringify(event)])).replayed,true);
  assert.equal((await db.query('SELECT status FROM commerce_payments')).rows[0].status,'partially_refunded');
  assert.equal((await db.query('SELECT qty FROM inv_stocks')).rows[0].qty,9);
  const ignored=await rpc(db,'commerce_apply_ordinary_refund',[JSON.stringify({...event,event_id:'evt-late-failure',status:'failed'})]);
  assert.equal(ignored.refund.status,'succeeded');
  const another=(await db.query(`INSERT INTO commerce_after_sales(order_id,order_item_id,location_id,user_id,type,status,reason_code,requested_amount,approved_amount)
    VALUES($1,$2,$3,$4,'refund_only','refund_pending','test',60,60) RETURNING id`,[order.id,item,location,customer])).rows[0].id;
  await assert.rejects(rpc(db,'commerce_prepare_ordinary_refund',[payment.id,another,'refund-two',customer]),/limit/i);
}));
test('ordinary RPCs are not executable by public consumers',()=>withDb(async db=>{
  const rows=(await db.query(`SELECT proname,has_function_privilege('anon',oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authed FROM pg_proc
    WHERE proname LIKE 'commerce_%ordinary%'`)).rows;
  assert(rows.length>=8); for(const row of rows){assert.equal(row.anon,false,row.proname); assert.equal(row.authed,false,row.proname);}
}));

test('held unknown payments block standard inventory reuse while unstarted orders expire normally',()=>withDb(async db=>{
  const order=await create(db); await prepare(db,order);
  await db.exec(`UPDATE commerce_orders SET reservation_expires_at=now()-interval '1 minute' WHERE id='${order.id}'`);
  await rpc(db,'commerce_release_expired_reservations',[]);
  const args=createArgs('competitor'); args[2]=JSON.stringify([{listing_id:listing,quantity:10}]);
  await assert.rejects(rpc(db,'commerce_create_ordinary_order',args),/out of stock/i);
  const unstarted=await create(db,'unstarted');
  await db.exec(`UPDATE commerce_orders SET reservation_expires_at=now()-interval '1 minute' WHERE id='${unstarted.id}'`);
  assert.equal(await rpc(db,'commerce_release_expired_reservations',[]),1);
  assert.equal((await db.query(`SELECT order_status FROM commerce_orders WHERE id='${unstarted.id}'`)).rows[0].order_status,'cancelled');
}));
test('legacy expired reservations release even for cancelled and closed unpaid orders',()=>withDb(async db=>{
  for (const status of ['cancelled','closed']) {
    const order=await rpc(db,'commerce_create_order_v2',createArgs(`legacy-${status}`).slice(0,12));
    await db.exec(`UPDATE commerce_orders SET order_status='${status}' WHERE id='${order.id}';
      UPDATE inventory_reservations SET expires_at=now()-interval '1 minute' WHERE order_id='${order.id}';
      UPDATE commerce_listings SET status='reserved' WHERE id='${listing}'`);
    assert.equal(await rpc(db,'commerce_release_expired_reservations',[]),0);
    assert.equal((await db.query(`SELECT status FROM inventory_reservations WHERE order_id='${order.id}'`)).rows[0].status,'expired');
    assert.equal((await db.query(`SELECT status FROM commerce_listings WHERE id='${listing}'`)).rows[0].status,'published');
    assert.equal((await db.query(`SELECT order_status FROM commerce_orders WHERE id='${order.id}'`)).rows[0].order_status,status);
  }
}));
test('legacy independently extended reservation remains active until its own deadline',()=>withDb(async db=>{
  const order=await rpc(db,'commerce_create_order_v2',createArgs('legacy-extended').slice(0,12));
  await db.exec(`UPDATE commerce_orders SET reservation_expires_at=now()-interval '1 minute' WHERE id='${order.id}';
    UPDATE inventory_reservations SET expires_at=now()+interval '1 hour' WHERE order_id='${order.id}';
    UPDATE commerce_listings SET status='reserved' WHERE id='${listing}'`);
  assert.equal(await rpc(db,'commerce_release_expired_reservations',[]),1);
  assert.equal((await db.query(`SELECT status FROM inventory_reservations WHERE order_id='${order.id}'`)).rows[0].status,'active');
  assert.equal((await db.query(`SELECT status FROM commerce_listings WHERE id='${listing}'`)).rows[0].status,'reserved');
  await db.exec(`UPDATE inventory_reservations SET expires_at=now()-interval '1 minute' WHERE order_id='${order.id}'`);
  assert.equal(await rpc(db,'commerce_release_expired_reservations',[]),0);
  assert.equal((await db.query(`SELECT status FROM inventory_reservations WHERE order_id='${order.id}'`)).rows[0].status,'expired');
}));
test('signed on-time success can arrive after the original deadline without losing inventory',()=>withDb(async db=>{
  const order=await create(db); const {payment}=await prepare(db,order);
  await db.exec(`UPDATE commerce_orders SET created_at=now()-interval '2 minutes',reservation_expires_at=now()-interval '1 minute' WHERE id='${order.id}'`);
  const paidAt=(await db.query("SELECT (now()-interval '90 seconds')::text AS at")).rows[0].at;
  const result=await rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify({...paidEvent(payment),paid_at:paidAt})]);
  assert.equal(result.payment.status,'succeeded');
  assert.equal((await db.query('SELECT qty FROM inv_stocks')).rows[0].qty,9);
}));
test('expired prepay lease uses the same intent, rejects old worker and atomically rejects missing stock',()=>withDb(async db=>{
  const order=await create(db); const first=await prepare(db,order);
  await db.exec(`UPDATE commerce_payments SET lease_expires_at=now()-interval '1 second' WHERE id='${first.payment.id}'`);
  const next=await prepare(db,order); assert.equal(next.payment.id,first.payment.id); assert.equal(next.acquired,true);
  assert.notEqual(next.lease_token,first.lease_token);
  await assert.rejects(rpc(db,'commerce_record_ordinary_prepay',[first.payment.id,first.lease_token,'old','{}',order.reservation_expires_at]),/lease/i);
  await db.exec('UPDATE inv_stocks SET qty=0');
  await assert.rejects(rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify(paidEvent(first.payment))]),/inventory unavailable/i);
  assert.equal((await db.query('SELECT status FROM commerce_payments')).rows[0].status,'processing');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM commerce_payment_events')).rows[0].n,0);
  assert.equal((await db.query('SELECT payment_status FROM commerce_orders')).rows[0].payment_status,'unpaid');
}));
test('ordinary ownership fail-closed includes external settlement references and location whitelist',()=>withDb(async db=>{
  await db.exec(`UPDATE inv_skus SET settlement_party_ref='third-party' WHERE id='${sku}'`);
  await assert.rejects(create(db),/ownership/i);
  await db.exec(`UPDATE inv_skus SET settlement_party_ref=NULL WHERE id='${sku}'`);
  const args=createArgs(); args[14]=[customer];
  await assert.rejects(rpc(db,'commerce_create_ordinary_order',args),/location/i);
}));

test('ABNORMAL refunds retain reserved amount and can reconcile to success on the same refund number',()=>withDb(async db=>{
  const order=await create(db); const {payment}=await prepare(db,order);
  await rpc(db,'commerce_apply_ordinary_payment',[JSON.stringify(paidEvent(payment))]);
  const item=(await db.query('SELECT id FROM commerce_order_items')).rows[0].id;
  const addSale=async(amount)=>(await db.query(`INSERT INTO commerce_after_sales(order_id,order_item_id,location_id,user_id,type,status,reason_code,requested_amount,approved_amount)
    VALUES($1,$2,$3,$4,'refund_only','refund_pending','test',$5,$5) RETURNING id`,[order.id,item,location,customer,amount])).rows[0].id;
  const sale=await addSale(80);
  const first=await rpc(db,'commerce_prepare_ordinary_refund',[payment.id,sale,'refund-abnormal',customer]);
  const event={event_id:'refund-abnormal-event',merchant_refund_no:first.refund.merchant_refund_no,merchant_id:'1749999844',
    transaction_id:'wx-test-transaction',provider_refund_id:'wx-refund-abnormal',status:'failed',total_fen:10000,refund_fen:8000,refunded_at:null};
  await rpc(db,'commerce_apply_ordinary_refund',[JSON.stringify(event)]);
  assert.equal((await rpc(db,'commerce_prepare_ordinary_refund',[payment.id,sale,'refund-abnormal',customer])).acquired,false);
  await db.exec(`UPDATE commerce_after_sales SET status='closed' WHERE id='${sale}'`);
  const second=await addSale(30);
  await assert.rejects(rpc(db,'commerce_prepare_ordinary_refund',[payment.id,second,'refund-excess',customer]),/limit/i);
  const reconciled=await rpc(db,'commerce_apply_ordinary_refund',[JSON.stringify({...event,event_id:'refund-resolved',status:'succeeded',refunded_at:new Date().toISOString()})]);
  assert.equal(reconciled.refund.status,'succeeded');
  assert.equal((await db.query('SELECT status FROM commerce_payments')).rows[0].status,'partially_refunded');
}));

test('signed NOT_FOUND can terminate only an expired, unleased intent without any prepay',()=>withDb(async db=>{
  const order=await create(db); const prepared=await prepare(db,order); const {payment}=prepared;
  const checkedAt=(await db.query("SELECT (now()-interval '1 second')::text AS at")).rows[0].at;
  const evidence={merchant_order_no:payment.merchant_order_no,merchant_id:'1749999844',status:'NOT_FOUND',checked_at:checkedAt};
  const close=(proof=evidence)=>rpc(db,'commerce_close_ordinary_payment',[payment.id,JSON.stringify(proof)]);
  await assert.rejects(close(),/evidence|deadline|lease|prepay/i);
  await db.exec(`UPDATE commerce_orders SET reservation_expires_at=now()-interval '3 minutes' WHERE id='${order.id}'`);
  await assert.rejects(close(),/evidence|deadline|lease|prepay/i);
  await db.exec(`UPDATE commerce_payments SET lease_expires_at=now()-interval '1 second' WHERE id='${payment.id}'`);
  const stale=(await db.query("SELECT (now()-interval '31 seconds')::text AS at")).rows[0].at;
  const future=(await db.query("SELECT (now()+interval '1 second')::text AS at")).rows[0].at;
  await assert.rejects(close({...evidence,checked_at:stale}),/evidence|proof/i);
  await assert.rejects(close({...evidence,checked_at:future}),/evidence|proof/i);
  await assert.rejects(close({...evidence,checked_at:null}),/evidence|proof/i);
  await db.exec(`UPDATE commerce_payments SET prepay_id='already-created' WHERE id='${payment.id}'`);
  await assert.rejects(close(),/evidence|prepay/i);
  await db.exec(`UPDATE commerce_payments SET prepay_id=NULL WHERE id='${payment.id}'`);
  const result=await close();
  assert.equal(result.status,'cancelled');
  assert.equal((await db.query('SELECT status FROM inventory_reservations')).rows[0].status,'released');
}));

test('ordinary recovery cursors support null-first fair scans independently of financial status',()=>withDb(async db=>{
  const columns=(await db.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public'
    AND table_name IN ('commerce_payments','commerce_refunds') AND column_name='ordinary_checked_at' AND data_type='timestamp with time zone'`)).rows;
  assert.equal(columns.length,2);
  const indexes=(await db.query(`SELECT indexdef FROM pg_indexes WHERE schemaname='public'
    AND indexname IN ('idx_ordinary_payments_recovery','idx_ordinary_refunds_recovery')`)).rows;
  assert.equal(indexes.length,2);
  for(const row of indexes){assert.match(row.indexdef,/ordinary_checked_at/);assert.match(row.indexdef,/WHERE/);}
}));
