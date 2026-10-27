-- Local only: emulate atomic inventory movement, no providers or real stock.
CREATE FUNCTION public.inv_apply_movement(p_sku_id uuid,p_location_id uuid,p_delta integer,p_ref_type text,p_ref_id uuid,p_epc text DEFAULT NULL,p_note text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE q int;
BEGIN
INSERT INTO inv_stocks(sku_id,location_id,qty) VALUES(p_sku_id,p_location_id,p_delta)
ON CONFLICT(sku_id,location_id) DO UPDATE SET qty=inv_stocks.qty+excluded.qty RETURNING qty INTO q;
INSERT INTO inv_stock_movements(sku_id,location_id,delta,balance_after,ref_type,ref_id,epc,note) VALUES(p_sku_id,p_location_id,p_delta,q,p_ref_type,p_ref_id,p_epc,p_note);
RETURN q;
END $$;