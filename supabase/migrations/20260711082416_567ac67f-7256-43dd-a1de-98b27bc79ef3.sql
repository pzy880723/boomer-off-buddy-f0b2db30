
DELETE FROM public.channel_sync_outbox
 WHERE sku_id = '70a6d177-97e7-4e99-be60-4fdcd2453575'
   AND inventory_version <= 2;

DELETE FROM public.inventory_sale_events
 WHERE source_order_id IN ('E2E-TEST-ORDER-001');

DELETE FROM public.return_inspections
 WHERE refund_source_order_id = 'E2E-REFUND-001';

DELETE FROM public.inv_stock_movements
 WHERE sku_id = '70a6d177-97e7-4e99-be60-4fdcd2453575'
   AND note IN ('e2e seed','seed warehouse','commit_sale E2E-TEST-ORDER-001','return inspection pass','e2e pass');

DELETE FROM public.inv_stocks
 WHERE sku_id = '70a6d177-97e7-4e99-be60-4fdcd2453575'
   AND location_id IN ('7111b585-7d7f-4777-b4ae-61ce2b868f78','f45dc754-b46b-411a-af7b-28e95ce2b1a0');

UPDATE public.inv_skus
   SET stock_qty = 0,
       sales_state = 'active',
       inventory_version = 0,
       updated_at = now()
 WHERE id = '70a6d177-97e7-4e99-be60-4fdcd2453575';
