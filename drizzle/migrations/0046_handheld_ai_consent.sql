-- Handheld AI processing consent (App Store 1.1.39). Additive only.
-- Rollback: DROP TABLE public.handheld_ai_consents; ALTER TABLE public.inv_listing_image_jobs, public.inv_product_content_image_jobs, public.custom_print_cards DROP COLUMN ai_actor_user_id, DROP COLUMN ai_policy_version;
CREATE TABLE IF NOT EXISTS public.handheld_ai_consents (
  user_id uuid NOT NULL,
  policy_version text NOT NULL CHECK (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-v[0-9]+$'),
  allowed boolean NOT NULL,
  device_id uuid,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, policy_version)
);
COMMENT ON TABLE public.handheld_ai_consents IS 'Per staff user + policy version AI processing decision. Written only by server code (service_role) with user_id taken from the verified session.';
REVOKE ALL ON public.handheld_ai_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.handheld_ai_consents TO authenticated;
GRANT ALL ON public.handheld_ai_consents TO service_role;
ALTER TABLE public.handheld_ai_consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff read own AI consent" ON public.handheld_ai_consents
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

ALTER TABLE public.inv_listing_image_jobs
  ADD COLUMN IF NOT EXISTS ai_actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS ai_policy_version text;
ALTER TABLE public.inv_product_content_image_jobs
  ADD COLUMN IF NOT EXISTS ai_actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS ai_policy_version text;
ALTER TABLE public.custom_print_cards
  ADD COLUMN IF NOT EXISTS ai_actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS ai_policy_version text;
COMMENT ON COLUMN public.inv_listing_image_jobs.ai_actor_user_id IS 'Staff whose AI consent is re-checked before every AI call; NULL = no consent context, AI is skipped.';
COMMENT ON COLUMN public.inv_product_content_image_jobs.ai_actor_user_id IS 'Staff whose AI consent is re-checked before every AI call; NULL = no consent context, AI is skipped.';
COMMENT ON COLUMN public.custom_print_cards.ai_actor_user_id IS 'Staff whose AI consent is re-checked before every AI call; NULL = no consent context, AI is skipped.';