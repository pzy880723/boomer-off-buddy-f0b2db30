ALTER TABLE public.inv_handheld_devices
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS install_id text;

CREATE UNIQUE INDEX IF NOT EXISTS inv_handheld_devices_owner_install_key
  ON public.inv_handheld_devices(owner_user_id, install_id)
  WHERE owner_user_id IS NOT NULL AND install_id IS NOT NULL;