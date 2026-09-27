-- Image-only convergence queue. No stock, product creation, or channel publishing writes.
CREATE TABLE public.youzan_image_refresh_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.inv_skus(id) ON DELETE CASCADE,
  shop_id uuid NOT NULL REFERENCES public.youzan_shops(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','retryable_failed','succeeded','cancelled')),
  claim_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  result jsonb,
  completed_claim_token uuid,
  stale_claim_token uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id,shop_id)
);
ALTER TABLE public.youzan_image_refresh_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.youzan_image_refresh_outbox FROM anon, authenticated;
GRANT ALL ON public.youzan_image_refresh_outbox TO service_role;
CREATE INDEX youzan_image_refresh_due ON public.youzan_image_refresh_outbox(status,next_run_at);

CREATE FUNCTION public.youzan_image_refresh_enqueue(p_sku_id uuid, p_shop_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  INSERT INTO youzan_image_refresh_outbox(sku_id,shop_id)
  SELECT c.sku_id,c.shop_id FROM sku_channel_listings c
  JOIN inv_skus s ON s.id=c.sku_id
  JOIN youzan_shops sh ON sh.id=c.shop_id
  JOIN sku_youzan_links l ON l.sku_id=c.sku_id AND l.shop_id=c.shop_id
  WHERE c.sku_id=p_sku_id AND (p_shop_id IS NULL OR c.shop_id=p_shop_id)
    AND c.channel='youzan_branch_offline' AND c.listing_status='published'
    AND s.status='active' AND s.sku_scope='custom'
    AND sh.role='branch' AND sh.status='active'
    AND l.role='branch_stock' AND l.status='linked' AND l.sync_stock AND l.yz_item_id>0
  ON CONFLICT(sku_id,shop_id) DO UPDATE SET
    revision=youzan_image_refresh_outbox.revision+1,
    status=CASE WHEN youzan_image_refresh_outbox.status='processing' THEN 'processing' ELSE 'queued' END,
    next_run_at=now(),last_error=NULL,updated_at=now();
$$;

CREATE FUNCTION public.youzan_image_refresh_on_images()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.image_paths IS DISTINCT FROM OLD.image_paths OR NEW.image_url IS DISTINCT FROM OLD.image_url THEN
    PERFORM youzan_image_refresh_enqueue(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER youzan_image_refresh_images AFTER UPDATE OF image_paths,image_url ON public.inv_skus
FOR EACH ROW EXECUTE FUNCTION public.youzan_image_refresh_on_images();

CREATE FUNCTION public.youzan_image_refresh_on_publish()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  -- Deliberately also runs for unchanged upserts: a late publisher may have sent an old snapshot.
  IF NEW.channel='youzan_branch_offline' AND NEW.listing_status='published' THEN
    PERFORM youzan_image_refresh_enqueue(NEW.sku_id,NEW.shop_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER youzan_image_refresh_publish AFTER INSERT OR UPDATE ON public.sku_channel_listings
FOR EACH ROW EXECUTE FUNCTION public.youzan_image_refresh_on_publish();

CREATE FUNCTION public.youzan_image_refresh_claim(p_limit integer DEFAULT 2)
RETURNS SETOF public.youzan_image_refresh_outbox LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH due AS (
    SELECT id FROM youzan_image_refresh_outbox
    WHERE (status IN ('queued','retryable_failed') AND next_run_at<=now())
      OR (status='processing' AND lease_until<now())
    ORDER BY next_run_at LIMIT greatest(1,least(coalesce(p_limit,2),6)) FOR UPDATE SKIP LOCKED
  ) UPDATE youzan_image_refresh_outbox q SET status='processing',claim_token=gen_random_uuid(),
    lease_until=now()+interval '10 minutes',attempts=attempts+1,updated_at=now()
  FROM due WHERE q.id=due.id RETURNING q.*;
$$;

CREATE FUNCTION public.youzan_image_refresh_snapshot(p_id uuid,p_claim_token uuid,p_revision bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object('sku_id',s.id,'shop_id',sh.id,'kdt_id',sh.kdt_id,
    'image_paths',s.image_paths,'image_url',s.image_url,'barcode',s.barcode,
    'hq_spu_id',hq.yz_item_id,'hq_shop_id',hq.shop_id,'branch_item_id',l.yz_item_id)
  FROM youzan_image_refresh_outbox q
  JOIN inv_skus s ON s.id=q.sku_id AND s.status='active' AND s.sku_scope='custom'
  JOIN youzan_shops sh ON sh.id=q.shop_id AND sh.role='branch' AND sh.status='active'
  JOIN sku_channel_listings c ON c.sku_id=s.id AND c.shop_id=sh.id
    AND c.channel='youzan_branch_offline' AND c.listing_status='published'
  JOIN sku_youzan_links l ON l.sku_id=s.id AND l.shop_id=sh.id AND l.role='branch_stock'
    AND l.status='linked' AND l.sync_stock AND l.yz_item_id>0
  JOIN sku_youzan_links hq ON hq.sku_id=s.id AND hq.role='hq_spu' AND hq.status='linked' AND hq.yz_item_id>0
  JOIN youzan_shops hs ON hs.id=hq.shop_id AND hs.role='hq' AND hs.status='active'
  WHERE q.id=p_id AND q.claim_token=p_claim_token AND q.revision=p_revision
    AND q.status='processing' AND q.lease_until>now()+interval '30 seconds'
    AND EXISTS(SELECT 1 FROM inv_locations loc JOIN inv_stocks st ON st.location_id=loc.id
      WHERE loc.shop_id=sh.id AND loc.is_active AND st.sku_id=s.id)
    -- A custom SKU is shop-exclusive. Never update a shared HQ master through this worker.
    AND NOT EXISTS(SELECT 1 FROM sku_channel_listings other WHERE other.sku_id=s.id
      AND other.channel='youzan_branch_offline' AND other.listing_status='published' AND other.shop_id<>sh.id)
    AND NOT EXISTS(SELECT 1 FROM sku_youzan_links other WHERE other.sku_id=s.id
      AND other.role='branch_stock' AND other.status='linked' AND other.sync_stock AND other.shop_id<>sh.id)
    AND NOT EXISTS(SELECT 1 FROM sku_youzan_links other WHERE other.role='hq_spu'
      AND other.shop_id=hq.shop_id AND other.yz_item_id=hq.yz_item_id AND other.sku_id<>s.id);
$$;

CREATE FUNCTION public.youzan_image_refresh_finish(p_id uuid,p_claim_token uuid,p_revision bigint,p_error text DEFAULT NULL,p_result jsonb DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE q youzan_image_refresh_outbox; v_status text;
BEGIN
  SELECT * INTO q FROM youzan_image_refresh_outbox WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF q.completed_claim_token=p_claim_token OR q.stale_claim_token=p_claim_token THEN RETURN 'duplicate'; END IF;
  IF q.claim_token IS DISTINCT FROM p_claim_token OR q.status<>'processing' THEN
    -- An expired writer may have returned from HTTP after its successor. Force another latest pass.
    UPDATE youzan_image_refresh_outbox SET revision=revision+1,
      status=CASE WHEN status='processing' THEN status ELSE 'queued' END,next_run_at=now(),stale_claim_token=p_claim_token WHERE id=p_id;
    RETURN 'stale';
  END IF;
  IF q.revision<>p_revision OR q.lease_until<=now()+interval '30 seconds' THEN v_status:='queued';
  ELSIF youzan_image_refresh_snapshot(p_id,p_claim_token,p_revision) IS NULL THEN v_status:='cancelled';
  ELSIF p_error IS NOT NULL THEN v_status:='retryable_failed';
  ELSE v_status:='succeeded'; END IF;
  UPDATE youzan_image_refresh_outbox SET status=v_status,claim_token=NULL,lease_until=NULL,
    next_run_at=CASE WHEN v_status='retryable_failed' THEN now()+make_interval(secs=>least(3600,30*power(2,least(q.attempts-1,7)))::int) ELSE now() END,
    last_error=CASE WHEN v_status='cancelled' THEN coalesce(left(p_error,1000),'image_target_not_eligible') ELSE left(p_error,1000) END,
    result=p_result,completed_claim_token=p_claim_token,updated_at=now() WHERE id=p_id;
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.youzan_image_refresh_enqueue(uuid,uuid),public.youzan_image_refresh_claim(integer),
  public.youzan_image_refresh_snapshot(uuid,uuid,bigint),public.youzan_image_refresh_finish(uuid,uuid,bigint,text,jsonb),
  public.youzan_image_refresh_on_images(),public.youzan_image_refresh_on_publish() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.youzan_image_refresh_enqueue(uuid,uuid),public.youzan_image_refresh_claim(integer),
  public.youzan_image_refresh_snapshot(uuid,uuid,bigint),public.youzan_image_refresh_finish(uuid,uuid,bigint,text,jsonb) TO service_role;
-- Intentionally no bulk backfill. Operator may enqueue reviewed SKU/shop pairs after deployment.
