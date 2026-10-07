CREATE TABLE public.custom_print_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 120),
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 500),
  formats text[] NOT NULL CHECK (cardinality(formats) BETWEEN 1 AND 2 AND formats <@ ARRAY['portrait','landscape']::text[]),
  reference_image_path text,
  reference_device_id uuid,
  content jsonb,
  state text NOT NULL DEFAULT 'custom' CHECK (state IN ('custom','preset')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','failed')),
  error text,
  version integer NOT NULL DEFAULT 1,
  client_op_id uuid NOT NULL,
  created_by uuid NOT NULL,
  published_by uuid,
  published_at timestamptz,
  job_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (created_by, client_op_id)
);
CREATE INDEX custom_print_cards_loc_idx ON public.custom_print_cards (state, location_id, updated_at DESC);
CREATE INDEX custom_print_cards_queue_idx ON public.custom_print_cards (status, updated_at) WHERE status IN ('queued','processing');

GRANT ALL ON public.custom_print_cards TO service_role;
ALTER TABLE public.custom_print_cards ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.custom_print_cards IS 'Store custom print cards; accessed only via server (service_role) after handheld session+location authorization.';

CREATE OR REPLACE FUNCTION public.custom_print_card_claim(p_limit integer, p_lease_seconds integer DEFAULT 180)
RETURNS SETOF public.custom_print_cards
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.custom_print_cards
     SET status = 'failed', error = '生成超时，请重新生成', job_token = NULL, lease_until = NULL,
         version = version + 1, updated_at = now()
   WHERE status = 'processing' AND lease_until < now() AND attempts >= 3;
  RETURN QUERY
  UPDATE public.custom_print_cards c
     SET status = 'processing', job_token = gen_random_uuid(), attempts = c.attempts + 1,
         lease_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 900)))
   WHERE c.id IN (
     SELECT id FROM public.custom_print_cards
      WHERE (status = 'queued' OR (status = 'processing' AND lease_until < now()))
        AND attempts < 3
      ORDER BY updated_at
      LIMIT greatest(1, least(p_limit, 6))
      FOR UPDATE SKIP LOCKED)
  RETURNING c.*;
END $$;
REVOKE ALL ON FUNCTION public.custom_print_card_claim(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_print_card_claim(integer, integer) TO service_role;