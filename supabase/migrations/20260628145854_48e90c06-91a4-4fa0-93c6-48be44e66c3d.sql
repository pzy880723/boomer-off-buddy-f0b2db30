CREATE TABLE public.auth_phone_otp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL DEFAULT 'login',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.auth_phone_otp TO service_role;

ALTER TABLE public.auth_phone_otp ENABLE ROW LEVEL SECURITY;

-- 仅 service_role 可访问；不创建任何 anon/authenticated 策略 = 默认拒绝
CREATE POLICY "service_role full access"
  ON public.auth_phone_otp
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX auth_phone_otp_phone_created_idx
  ON public.auth_phone_otp (phone, created_at DESC);

CREATE INDEX auth_phone_otp_ip_created_idx
  ON public.auth_phone_otp (ip, created_at DESC);