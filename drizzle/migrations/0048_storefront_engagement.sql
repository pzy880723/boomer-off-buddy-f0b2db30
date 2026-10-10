-- Storefront discovery: verified-customer product opens, favorites, vocabulary search hits.
-- Rollback: DROP FUNCTION public.storefront_record_engagement(uuid,text,uuid,text,text,text); DROP FUNCTION public.storefront_product_engagement_counts(uuid[]); DROP FUNCTION public.storefront_hot_search_terms(int,int);
--           DROP TABLE public.storefront_search_term_hits, public.storefront_product_favorites, public.storefront_product_opens, public.storefront_engagement_quota;
CREATE TABLE public.storefront_product_opens (
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.commerce_listings(id) ON DELETE CASCADE,
  open_day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, listing_id, open_day)
);
CREATE INDEX storefront_product_opens_listing_day_idx ON public.storefront_product_opens (listing_id, open_day);

CREATE TABLE public.storefront_product_favorites (
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.commerce_listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, listing_id)
);
CREATE INDEX storefront_product_favorites_listing_idx ON public.storefront_product_favorites (listing_id);

-- Only vocabulary-validated terms; customer stored as per-day/per-term one-way key, no raw text history.
CREATE TABLE public.storefront_search_term_hits (
  hit_day date NOT NULL,
  term_key text NOT NULL CHECK (term_key ~ '^(brand|facet|category):[A-Za-z0-9_\-]{1,80}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  visitor_key text NOT NULL CHECK (char_length(visitor_key) = 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hit_day, term_key, visitor_key)
);
CREATE INDEX storefront_search_term_hits_term_idx ON public.storefront_search_term_hits (term_key, hit_day);

CREATE TABLE public.storefront_engagement_quota (
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  quota_day date NOT NULL,
  event_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, quota_day)
);

GRANT ALL ON public.storefront_product_opens, public.storefront_product_favorites,
  public.storefront_search_term_hits, public.storefront_engagement_quota TO service_role;
REVOKE ALL ON public.storefront_product_opens, public.storefront_product_favorites,
  public.storefront_search_term_hits, public.storefront_engagement_quota FROM anon, authenticated;
ALTER TABLE public.storefront_product_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_product_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_search_term_hits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.storefront_engagement_quota ENABLE ROW LEVEL SECURITY;
CREATE POLICY "storefront opens backend only" ON public.storefront_product_opens FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "storefront favorites backend only" ON public.storefront_product_favorites FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "storefront search hits backend only" ON public.storefront_search_term_hits FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "storefront quota backend only" ON public.storefront_engagement_quota FOR ALL TO service_role USING (true) WITH CHECK (true);

-- p_action: open | favorite | unfavorite | search. Returns {recorded, active?, reason?}.
CREATE OR REPLACE FUNCTION public.storefront_record_engagement(
  p_customer_id uuid, p_action text, p_listing_id uuid, p_term_key text, p_label text, p_visitor_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_count integer;
  v_rows integer;
BEGIN
  IF p_customer_id IS NULL THEN RAISE EXCEPTION 'customer_required'; END IF;
  INSERT INTO storefront_engagement_quota (customer_id, quota_day, event_count) VALUES (p_customer_id, v_day, 1)
  ON CONFLICT (customer_id, quota_day) DO UPDATE SET event_count = storefront_engagement_quota.event_count + 1
  RETURNING event_count INTO v_count;
  IF v_count > 500 THEN RETURN jsonb_build_object('recorded', false, 'reason', 'rate_limited'); END IF;

  IF p_action IN ('open','favorite','unfavorite') THEN
    IF NOT EXISTS (SELECT 1 FROM commerce_listings WHERE id = p_listing_id AND status = 'published') THEN
      RETURN jsonb_build_object('recorded', false, 'reason', 'product_unavailable');
    END IF;
  END IF;

  IF p_action = 'open' THEN
    INSERT INTO storefront_product_opens (customer_id, listing_id, open_day) VALUES (p_customer_id, p_listing_id, v_day)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN jsonb_build_object('recorded', v_rows > 0, 'reason', CASE WHEN v_rows > 0 THEN NULL ELSE 'already_counted_today' END);
  ELSIF p_action = 'favorite' THEN
    INSERT INTO storefront_product_favorites (customer_id, listing_id) VALUES (p_customer_id, p_listing_id) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN jsonb_build_object('recorded', v_rows > 0, 'active', true);
  ELSIF p_action = 'unfavorite' THEN
    DELETE FROM storefront_product_favorites WHERE customer_id = p_customer_id AND listing_id = p_listing_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN jsonb_build_object('recorded', v_rows > 0, 'active', false);
  ELSIF p_action = 'search' THEN
    DELETE FROM storefront_search_term_hits WHERE hit_day < v_day - 31;
    INSERT INTO storefront_search_term_hits (hit_day, term_key, label, visitor_key) VALUES (v_day, p_term_key, p_label, p_visitor_key)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN jsonb_build_object('recorded', v_rows > 0);
  END IF;
  RAISE EXCEPTION 'invalid_action';
END $$;

CREATE OR REPLACE FUNCTION public.storefront_product_engagement_counts(p_listing_ids uuid[])
RETURNS TABLE(listing_id uuid, view_count integer, favorite_count integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT l.id,
    (SELECT count(DISTINCT o.customer_id)::int FROM storefront_product_opens o
      WHERE o.listing_id = l.id AND o.open_day > (now() AT TIME ZONE 'Asia/Shanghai')::date - 30),
    (SELECT count(*)::int FROM storefront_product_favorites f WHERE f.listing_id = l.id)
  FROM unnest(p_listing_ids) AS l(id)
$$;

CREATE OR REPLACE FUNCTION public.storefront_hot_search_terms(p_window_days integer DEFAULT 30, p_limit integer DEFAULT 10)
RETURNS TABLE(term_key text, label text, searchers integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT h.term_key, (array_agg(h.label ORDER BY h.hit_day DESC))[1], count(*)::int
  FROM storefront_search_term_hits h
  WHERE h.hit_day > (now() AT TIME ZONE 'Asia/Shanghai')::date - LEAST(GREATEST(p_window_days,1),31)
  GROUP BY h.term_key
  ORDER BY count(*) DESC, h.term_key
  LIMIT LEAST(GREATEST(p_limit,1),20)
$$;

REVOKE ALL ON FUNCTION public.storefront_record_engagement(uuid,text,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storefront_product_engagement_counts(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storefront_hot_search_terms(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storefront_record_engagement(uuid,text,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.storefront_product_engagement_counts(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.storefront_hot_search_terms(integer,integer) TO service_role;