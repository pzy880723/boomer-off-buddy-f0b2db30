-- Synthetic supporting columns/tables, never production DDL.
-- Trigger definitions and attachments themselves come from the live snapshots.
ALTER TABLE inv_locations ADD COLUMN shop_id uuid;
ALTER TABLE inv_skus ADD COLUMN barcode text, ADD COLUMN sku_scope text DEFAULT 'standard',
  ADD COLUMN image_paths text[];
ALTER TABLE commerce_orders ADD COLUMN payment_route jsonb;
ALTER TABLE commerce_payments ADD COLUMN payment_channel text DEFAULT 'legacy',
  ADD COLUMN merchant_order_no text, ADD COLUMN payer_openid text,
  ADD COLUMN merchant_snapshot jsonb, ADD COLUMN currency text DEFAULT 'CNY';
ALTER TABLE pos_customer_coupons ADD COLUMN reserved_order_id uuid;
ALTER TABLE pos_customer_coupons DROP CONSTRAINT pos_customer_coupons_status_check;
ALTER TABLE pos_customer_coupons ADD CHECK (status IN ('active','reserved','used','expired','void'));
CREATE TABLE youzan_stock_sync_queue (
  sku_id uuid,shop_id uuid,location_id uuid,target_stock integer,
  action text,reason text,status text,next_run_at timestamptz,
  last_error text,updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX uq_youzan_stock_sync_queue_pending
  ON youzan_stock_sync_queue(sku_id,shop_id) WHERE status IN ('pending','failed');
