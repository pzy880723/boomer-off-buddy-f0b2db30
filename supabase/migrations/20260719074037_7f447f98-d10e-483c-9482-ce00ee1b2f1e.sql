CREATE TABLE public.aigc_sso_tickets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX aigc_sso_tickets_user_id_idx ON public.aigc_sso_tickets(user_id);
CREATE INDEX aigc_sso_tickets_expires_at_idx ON public.aigc_sso_tickets(expires_at);

-- service_role only; no anon/authenticated grants
GRANT ALL ON public.aigc_sso_tickets TO service_role;

ALTER TABLE public.aigc_sso_tickets ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated → RLS denies all client-side access.
-- service_role bypasses RLS, so the server routes can operate normally.

CREATE OR REPLACE FUNCTION public.aigc_sso_cleanup_expired()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.aigc_sso_tickets
   WHERE created_at < now() - interval '7 days';
$$;
