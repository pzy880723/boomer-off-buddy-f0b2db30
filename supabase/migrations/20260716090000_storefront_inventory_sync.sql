-- Keep one-off custom products mutually exclusive between physical stores and
-- the BOOMER-OFF self-operated storefront.

CREATE OR REPLACE FUNCTION public.sync_commerce_listing_on_store_sale()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'processed' OR NEW.sku_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- A store sale is the physical source of truth. Release any unpaid online
  -- hold before marking the listing sold so the customer cannot pay stale stock.
  WITH released AS (
    UPDATE public.inventory_reservations
       SET status = 'released', released_at = coalesce(NEW.processed_at, now())
     WHERE sku_id = NEW.sku_id
       AND status = 'active'
    RETURNING order_id
  )
  UPDATE public.commerce_orders
     SET order_status = 'cancelled',
         cancelled_at = coalesce(NEW.processed_at, now()),
         updated_at = now()
   WHERE id IN (SELECT order_id FROM released)
     AND payment_status = 'unpaid'
     AND order_status = 'pending_payment';

  UPDATE public.commerce_listings
     SET status = 'sold',
         sold_at = coalesce(NEW.processed_at, now()),
         updated_at = now()
   WHERE sku_id = NEW.sku_id
     AND status IN ('published', 'reserved');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_commerce_listing_on_store_sale
  ON public.inventory_sale_events;
CREATE TRIGGER trg_sync_commerce_listing_on_store_sale
  AFTER INSERT ON public.inventory_sale_events
  FOR EACH ROW
  WHEN (NEW.status = 'processed')
  EXECUTE FUNCTION public.sync_commerce_listing_on_store_sale();

CREATE OR REPLACE FUNCTION public.sync_branch_channels_on_commerce_reservation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel_listing record;
  v_inventory_version bigint;
  v_can_restore boolean := false;
BEGIN
  SELECT inventory_version
    INTO v_inventory_version
    FROM public.inv_skus
   WHERE id = NEW.sku_id;

  IF TG_OP = 'INSERT' AND NEW.status = 'active' THEN
    FOR v_channel_listing IN
      SELECT id, channel, shop_id
        FROM public.sku_channel_listings
       WHERE sku_id = NEW.sku_id
         AND channel = 'youzan_branch_offline'
         AND listing_status IN ('published', 'shelved', 'unshelved')
    LOOP
      INSERT INTO public.channel_sync_outbox (
        sku_id, channel_listing_id, channel, shop_id, action,
        priority, inventory_version, target_stock, dedupe_key
      ) VALUES (
        NEW.sku_id, v_channel_listing.id, v_channel_listing.channel,
        v_channel_listing.shop_id, 'set_stock_zero', 1,
        coalesce(v_inventory_version, 0), 0,
        'commerce_reserve:' || NEW.id::text || ':' || v_channel_listing.id::text || ':zero'
      ) ON CONFLICT (dedupe_key) DO NOTHING;

      INSERT INTO public.channel_sync_outbox (
        sku_id, channel_listing_id, channel, shop_id, action,
        priority, inventory_version, dedupe_key
      ) VALUES (
        NEW.sku_id, v_channel_listing.id, v_channel_listing.channel,
        v_channel_listing.shop_id, 'delist', 1,
        coalesce(v_inventory_version, 0),
        'commerce_reserve:' || NEW.id::text || ':' || v_channel_listing.id::text || ':delist'
      ) ON CONFLICT (dedupe_key) DO NOTHING;
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = 'active'
     AND NEW.status IN ('expired', 'released') THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.commerce_listings listing
        JOIN public.inv_stocks stock
          ON stock.sku_id = listing.sku_id
         AND stock.location_id = listing.location_id
       WHERE listing.id = NEW.listing_id
         AND listing.status = 'published'
         AND stock.qty > 0
    ) INTO v_can_restore;

    IF v_can_restore THEN
      FOR v_channel_listing IN
        SELECT id, channel, shop_id
          FROM public.sku_channel_listings
         WHERE sku_id = NEW.sku_id
           AND channel = 'youzan_branch_offline'
           AND listing_status IN ('published', 'shelved', 'unshelved')
      LOOP
        INSERT INTO public.channel_sync_outbox (
          sku_id, channel_listing_id, channel, shop_id, action,
          priority, inventory_version, target_stock, dedupe_key
        ) VALUES (
          NEW.sku_id, v_channel_listing.id, v_channel_listing.channel,
          v_channel_listing.shop_id, 'restore_after_return', 3,
          coalesce(v_inventory_version, 0), 1,
          'commerce_reservation_release:' || NEW.id::text || ':' || v_channel_listing.id::text
        ) ON CONFLICT (dedupe_key) DO NOTHING;
      END LOOP;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_branch_channels_on_commerce_reservation
  ON public.inventory_reservations;
CREATE TRIGGER trg_sync_branch_channels_on_commerce_reservation
  AFTER INSERT OR UPDATE OF status ON public.inventory_reservations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_branch_channels_on_commerce_reservation();

REVOKE ALL ON FUNCTION public.sync_commerce_listing_on_store_sale() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_branch_channels_on_commerce_reservation() FROM PUBLIC;
