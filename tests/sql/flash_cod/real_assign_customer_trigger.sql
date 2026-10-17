CREATE OR REPLACE FUNCTION public.commerce_assign_storefront_customer()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.source_channel = 'storefront' AND NEW.customer_id IS NULL AND NEW.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.commerce_customers WHERE id = NEW.user_id) THEN
    NEW.customer_id := NEW.user_id;
  END IF;
  RETURN NEW;
END;
$function$

