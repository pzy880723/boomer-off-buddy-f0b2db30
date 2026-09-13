REVOKE ALL ON public.commerce_customer_notifications FROM anon, authenticated;
REVOKE ALL ON public.commerce_sms_outbox FROM anon, authenticated;
REVOKE ALL ON public.commerce_refund_intents FROM anon, authenticated;
GRANT ALL ON public.commerce_customer_notifications TO service_role;
GRANT ALL ON public.commerce_sms_outbox TO service_role;
GRANT ALL ON public.commerce_refund_intents TO service_role;