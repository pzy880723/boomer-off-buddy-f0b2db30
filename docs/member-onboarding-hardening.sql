REVOKE ALL ON public.member_onboarding_jobs FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.member_onboarding_jobs TO service_role;