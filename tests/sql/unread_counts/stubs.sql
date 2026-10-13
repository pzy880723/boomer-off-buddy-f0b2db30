do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role service_role; exception when duplicate_object then null; end $$;
CREATE TABLE public.inv_handheld_notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid, location_id uuid, kind text, title text,
  payload jsonb DEFAULT '{}', ts timestamptz DEFAULT now(), user_id uuid, action_status text, ref_type text, ref_id uuid);
CREATE TABLE public.handheld_notification_reads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notification_id uuid, user_id uuid, read_at timestamptz, created_at timestamptz DEFAULT now(), UNIQUE(notification_id,user_id));
CREATE TABLE public.support_conversations(id uuid PRIMARY KEY, location_id uuid, status text DEFAULT 'open');
CREATE TABLE public.support_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, sender_type text, internal boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE public.support_participants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, user_id uuid, last_read_at timestamptz);
