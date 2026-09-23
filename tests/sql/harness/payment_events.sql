-- 隔离库专用：commerce_payment_events 结构桩（仅列定义，无数据）
CREATE TABLE IF NOT EXISTS public.commerce_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid, provider text NOT NULL,
  provider_event_id text, event_type text NOT NULL, signature_verified boolean, payload jsonb,
  processing_status text DEFAULT 'pending', error text, received_at timestamptz DEFAULT now(), processed_at timestamptz,
  UNIQUE (provider, provider_event_id));
