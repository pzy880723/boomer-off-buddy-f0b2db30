-- Consumer identities are issued by the Tencent Cloud auth service.
-- They are intentionally separate from ERP employee accounts in auth.users.

CREATE TABLE public.commerce_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_subject text NOT NULL UNIQUE,
  phone text,
  wechat_openid text,
  wechat_unionid text,
  nickname text,
  avatar_url text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_customers_phone_unique
  ON public.commerce_customers(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX commerce_customers_wechat_unionid_unique
  ON public.commerce_customers(wechat_unionid) WHERE wechat_unionid IS NOT NULL;

CREATE TABLE public.commerce_customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.commerce_customers(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('phone','wechat')),
  provider_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
CREATE INDEX commerce_customer_identities_customer
  ON public.commerce_customer_identities(customer_id);

ALTER TABLE public.commerce_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_customer_identities ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.commerce_customers, public.commerce_customer_identities TO service_role;

ALTER TABLE public.commerce_orders
  DROP CONSTRAINT IF EXISTS commerce_orders_user_id_fkey;
ALTER TABLE public.commerce_orders
  DROP CONSTRAINT IF EXISTS commerce_orders_customer_id_fkey;
ALTER TABLE public.commerce_orders
  ADD CONSTRAINT commerce_orders_customer_id_fkey
  FOREIGN KEY (customer_id) REFERENCES public.commerce_customers(id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_storefront_customer_order_op
  ON public.commerce_orders(customer_id, idempotency_key)
  WHERE source_channel = 'storefront' AND customer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.commerce_assign_storefront_customer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.source_channel = 'storefront' AND NEW.customer_id IS NULL AND NEW.user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.commerce_customers WHERE id = NEW.user_id) THEN
    NEW.customer_id := NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS commerce_assign_storefront_customer ON public.commerce_orders;
CREATE TRIGGER commerce_assign_storefront_customer
  BEFORE INSERT OR UPDATE OF user_id, customer_id, source_channel
  ON public.commerce_orders
  FOR EACH ROW EXECUTE FUNCTION public.commerce_assign_storefront_customer();
