CREATE TABLE public.pos_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id),
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id),
  operator_id uuid NOT NULL,
  payment_profile_id uuid REFERENCES public.store_payment_profiles(id),
  settlement_subject_id uuid REFERENCES public.payment_subjects(id),
  provider text NOT NULL CHECK (provider IN ('wechat','alipay')),
  mode text NOT NULL CHECK (mode IN ('merchant_scan','customer_scan')),
  out_trade_no text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'CNY',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','user_paying','paid','failed','closed','expired')),
  provider_transaction_id text,
  auth_code_hash text,
  auth_code_last4 text,
  qr_content text,
  code_url text,
  expires_at timestamptz,
  client_op_id text NOT NULL,
  customer_id uuid,
  sale_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  order_id uuid REFERENCES public.commerce_orders(id),
  error_code text,
  error_message text,
  paid_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_pos_payment_attempt_out_trade_no
  ON public.pos_payment_attempts(out_trade_no);
CREATE UNIQUE INDEX uniq_pos_payment_attempt_client_op
  ON public.pos_payment_attempts(client_op_id);
CREATE UNIQUE INDEX uniq_pos_payment_attempt_provider_txn
  ON public.pos_payment_attempts(provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX idx_pos_payment_attempt_shift ON public.pos_payment_attempts(shift_id, created_at DESC);
CREATE INDEX idx_pos_payment_attempt_status ON public.pos_payment_attempts(status, expires_at);

ALTER TABLE public.pos_payment_attempts
  ADD CONSTRAINT pos_payment_attempts_auth_code_hashed
  CHECK (auth_code_hash IS NULL OR length(auth_code_hash) = 64);

GRANT ALL ON public.pos_payment_attempts TO service_role;
ALTER TABLE public.pos_payment_attempts ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_pos_payment_attempts_updated_at
  BEFORE UPDATE ON public.pos_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();