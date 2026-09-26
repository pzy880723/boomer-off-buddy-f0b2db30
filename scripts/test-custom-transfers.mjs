import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');

// Isolated PostgreSQL engine. No production credentials, storage or workers.
const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT null::uuid $$;
CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public bool,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(bucket_id text,name text);
CREATE TABLE user_roles(user_id uuid,role text);
CREATE TABLE user_location_perms(user_id uuid,location_id uuid);
CREATE TABLE inv_locations(id uuid PRIMARY KEY,name text,kind text,shop_id uuid,is_active bool DEFAULT true);
CREATE TABLE inv_skus(id uuid PRIMARY KEY,name text,sku_code text,barcode text,kind text DEFAULT 'single',
 is_custom_price bool DEFAULT true,inventory_policy text DEFAULT 'tracked',status text DEFAULT 'active',is_display bool DEFAULT true,
 price_tier numeric DEFAULT 59.9,notes text,grade text,category text,image_paths text[] DEFAULT '{}',image_url text,stock_qty int DEFAULT 0);
CREATE TABLE inv_stocks(sku_id uuid,location_id uuid,qty int,PRIMARY KEY(sku_id,location_id));
CREATE TABLE inv_stock_movements(id uuid DEFAULT gen_random_uuid(),sku_id uuid,location_id uuid,delta int,ref_type text,ref_id uuid,created_by uuid);
CREATE TABLE inv_epcs(sku_id uuid,status text);
CREATE TABLE stock_transfers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text DEFAULT gen_random_uuid()::text,
 kind text NOT NULL,status text DEFAULT 'posted',qty int,from_location_id uuid,to_location_id uuid,from_shop_id uuid,to_shop_id uuid,
 notes text,shipped_by uuid,shipped_at timestamptz,received_by uuid,received_at timestamptz,
 created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),youzan_sync_status text DEFAULT 'pending',
 CONSTRAINT stock_transfers_kind_check CHECK(kind IN ('wh_to_shop','shop_to_shop','shop_to_wh','consume')));
CREATE TABLE stock_transfer_lines(id uuid DEFAULT gen_random_uuid(),transfer_id uuid REFERENCES stock_transfers,sku_id uuid,
 expected_qty int,shipped_qty int,received_qty int DEFAULT 0,UNIQUE(transfer_id,sku_id));
ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer_lines ENABLE ROW LEVEL SECURITY;
GRANT ALL ON stock_transfers,stock_transfer_lines TO authenticated;
CREATE POLICY legacy_transfers ON stock_transfers FOR ALL TO authenticated USING(true) WITH CHECK(true);
CREATE POLICY legacy_lines ON stock_transfer_lines FOR ALL TO authenticated USING(true) WITH CHECK(true);
CREATE TABLE inventory_reservations(id uuid PRIMARY KEY,sku_id uuid,location_id uuid,quantity int,status text);
CREATE TABLE inventory_reservation_lines(reservation_id uuid,stock_sku_id uuid,location_id uuid,quantity int);
CREATE TABLE commerce_listings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sku_id uuid,location_id uuid,title text,description text,
 price numeric,condition_grade text,category text,image_paths jsonb,status text,product_type text,published_at timestamptz,
 created_by uuid,updated_at timestamptz,UNIQUE(sku_id,location_id));
CREATE TABLE youzan_stock_sync_queue(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sku_id uuid,shop_id uuid,location_id uuid,target_stock int,
 reason text,action text,status text DEFAULT 'pending',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),attempts int DEFAULT 0,next_run_at timestamptz DEFAULT now(),last_error text);
CREATE UNIQUE INDEX uq_youzan_stock_sync_queue_pending ON youzan_stock_sync_queue(sku_id,shop_id) WHERE status IN ('pending','failed');
CREATE TABLE handheld_youzan_release_outbox(sku_id uuid,shop_id uuid,location_id uuid,status text DEFAULT 'pending',
 next_attempt_at timestamptz,attempts int DEFAULT 0,last_error text,updated_at timestamptz,UNIQUE(sku_id,shop_id));
CREATE FUNCTION inv_apply_movement(uuid,uuid,int,text,uuid,text,text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE q int; BEGIN
 INSERT INTO inv_stocks VALUES($1,$2,$3) ON CONFLICT(sku_id,location_id) DO UPDATE SET qty=inv_stocks.qty+excluded.qty RETURNING qty INTO q;
 INSERT INTO inv_stock_movements(sku_id,location_id,delta,ref_type,ref_id) VALUES($1,$2,$3,$4,$5); RETURN q;
END $$;
`);
await db.exec(await readFile(new URL('../supabase/migrations/20260926170909_custom_product_transfers.sql',import.meta.url),'utf8'));
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const hq=id(1),staff=id(2),stranger=id(3),a=id(11),b=id(12),shop=id(13),sku=id(21),other=id(22);
await db.query(`INSERT INTO user_roles VALUES($1,'hq_operator'),($2,'store_staff'),($3,'shop_manager')`,[hq,staff,stranger]);
await db.query(`INSERT INTO inv_locations(id,name,kind,shop_id) VALUES($1,'A','shop',$3),($2,'B','shop',NULL)`,[a,b,shop]);
await db.query(`INSERT INTO user_location_perms VALUES($1,$2)`,[staff,b]);
await db.query(`INSERT INTO inv_skus(id,name,sku_code,barcode) VALUES($1,'One','SKU1','2000000000001'),($2,'Two','SKU2','2000000000002')`,[sku,other]);
await db.query(`INSERT INTO inv_stocks VALUES($1,$3,1),($2,$3,1)`,[sku,other,a]);
const create=(user,key,lines=[{sku_id:sku,qty:1}],to=b)=>db.query(`select custom_transfer_create($1,$2,$3,$4,$5,$6::jsonb) as result`,[user,key,a,to,'test',JSON.stringify(lines)]).then(r=>r.rows[0].result);
const receive=(user,tid,photos)=>db.query(`select custom_transfer_receive($1,$2,$3::uuid[]) as result`,[user,tid,photos]).then(r=>r.rows[0].result);
const qty=async(loc)=>Number((await db.query(`select coalesce(sum(qty),0)::int as qty from inv_stocks where sku_id=$1 and location_id=$2`,[sku,loc])).rows[0].qty);
await assert.rejects(create(staff,'denied'),/transfer_create_forbidden/);
await assert.rejects(create(stranger,'denied'),/transfer_create_forbidden/);
await assert.rejects(create(hq,'same',undefined,a),/same_location/);
await assert.rejects(create(hq,'zero',[{sku_id:sku,qty:0}]),/invalid_lines/);
await assert.rejects(create(hq,'duplicate',[{sku_id:sku,qty:1},{sku_id:sku,qty:1}]),/invalid_lines/);
await db.query(`INSERT INTO inventory_reservations VALUES($1,$2,$3,1,'active')`,[id(30),sku,a]);
await assert.rejects(create(hq,'reserved'),/stock_reserved/);
await db.exec(`DELETE FROM inventory_reservations`);
await db.query(`INSERT INTO inventory_reservations VALUES($1,$2,$3,1,'active')`,[id(31),other,a]);
await db.query(`INSERT INTO inventory_reservation_lines VALUES($1,$2,$3,1)`,[id(31),sku,a]);
await assert.rejects(create(hq,'component-reserved'),/stock_reserved/);
await db.exec(`DELETE FROM inventory_reservation_lines; DELETE FROM inventory_reservations`);
await assert.rejects(db.query(`select custom_transfer_products($1,$2,'')`,[staff,a]),/transfer_create_forbidden/);
assert.equal((await db.query(`select custom_transfer_products($1,$2,'SKU1') as products`,[hq,a])).rows[0].products.length,1);
await db.query(`UPDATE inv_stocks SET qty=2 WHERE sku_id=$1`,[sku]);
await assert.rejects(create(hq,'partial'),/whole_custom_item_required/);
await db.query(`UPDATE inv_stocks SET qty=1 WHERE sku_id=$1`,[sku]);
await db.query(`UPDATE inv_skus SET is_custom_price=false WHERE id=$1`,[other]);
await assert.rejects(create(hq,'standard',[{sku_id:other,qty:1}]),/custom_only/);
await assert.rejects(create(hq,'atomic',[{sku_id:sku,qty:1},{sku_id:other,qty:1}]),/custom_only/);
assert.equal(await qty(a),1,'Failed multi-line transaction must not move its first line');
await db.query(`INSERT INTO youzan_stock_sync_queue(sku_id,shop_id,location_id,target_stock,status) VALUES($1,$2,$3,1,'running')`,[sku,shop,a]);
await assert.rejects(create(hq,'busy'),/source_sync_busy/);
assert.equal(await qty(a),1);
await db.exec(`UPDATE youzan_stock_sync_queue SET status='pending'`);
const first=await create(hq,'once');
assert.equal((await db.query(`SELECT count(*)::int AS n FROM youzan_stock_sync_queue`)).rows[0].n,1,'Reuse pending channel job under the production partial unique index');
await db.exec(`SET ROLE authenticated`);
assert.equal((await db.query(`select count(*)::int as n from stock_transfers where id=$1`,[first.id])).rows[0].n,0);
await assert.rejects(db.query(`INSERT INTO stock_transfer_lines(transfer_id,sku_id,expected_qty) VALUES($1,$2,1)`,[first.id,other]),/row-level security/);
await assert.rejects(db.query(`INSERT INTO stock_transfers(kind,status,qty) VALUES('custom','received',1)`),/row-level security/);
await db.exec(`RESET ROLE`);
assert.equal(await qty(a),0); assert.equal(await qty(b),0);
assert.equal((await create(hq,'once')).id,first.id);
await assert.rejects(create(hq,'once',[{sku_id:other,qty:1}]),/idempotency_conflict/);
await assert.rejects(create(hq,'another'),/stock_unavailable/);
await assert.rejects(receive(stranger,first.id,[]),/transfer_receive_forbidden/);
await assert.rejects(receive(staff,first.id,[]),/receipt_required/);
const photo=id(40);
await db.query(`INSERT INTO stock_transfer_receipts(id,transfer_id,uploaded_by,storage_path) VALUES($1,$2,$3,$4)`,[photo,first.id,staff,`${first.id}/${staff}/proof.jpg`]);
await assert.rejects(receive(staff,first.id,[photo]),/receipt_missing/);
await db.query(`INSERT INTO storage.objects VALUES('transfer-receipts',$1)`,[`${first.id}/${staff}/proof.jpg`]);
await assert.rejects(receive(hq,first.id,[photo]),/receipt_missing/);
await assert.rejects(receive(staff,first.id,[photo,photo]),/receipt_missing/);
await assert.rejects(receive(staff,first.id,[photo]),/source_sync_pending/);
await db.exec(`UPDATE youzan_stock_sync_queue SET status='done'`);
const received=await receive(staff,first.id,[photo]);
assert.equal(received.status,'received'); assert.equal(await qty(a),0); assert.equal(await qty(b),1);
await receive(staff,first.id,[photo]); assert.equal(await qty(b),1);
const movements=(await db.query(`select count(*)::int as n from inv_stock_movements`)).rows[0].n;
assert.equal(movements,2);
assert.equal((await db.query(`select barcode from inv_skus where id=$1`,[sku])).rows[0].barcode,'2000000000001');
assert.equal((await db.query(`select count(*)::int as n from commerce_listings where sku_id=$1 and status='published'`,[sku])).rows[0].n,1);
for (const role of ['anon','authenticated']) {
 const r=await db.query(`select has_function_privilege($1,'custom_transfer_create(uuid,text,uuid,uuid,text,jsonb)','execute') as allowed`,[role]);
 assert.equal(r.rows[0].allowed,false);
}
console.log('PASS: transfer permissions, raw-table RLS, reservations, atomicity, replay, media ownership, source sync barrier, stock conservation and barcode identity');
await db.close();
