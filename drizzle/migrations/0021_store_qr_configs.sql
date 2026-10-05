-- 门店二维码配置（每门店每用途一条；仅 super_admin 可写，门店员工按库位只读；anon 无权限）。
-- 图片只存私有桶 store-qr 的路径，读取时服务端签名；不预置任何真实二维码。
-- ROLLBACK SQL:
--   DROP TRIGGER IF EXISTS trg_store_qr_configs_version ON public.store_qr_configs;
--   DROP FUNCTION IF EXISTS public.store_qr_configs_bump_version();
--   DROP TABLE IF EXISTS public.store_qr_configs;
CREATE TABLE IF NOT EXISTS public.store_qr_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.inv_locations(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('wechat_follow','wecom_contact','mini_program','storefront')),
  target_url text CHECK (target_url IS NULL OR target_url ~ '^https://'),
  image_bucket text CHECK (image_bucket IS NULL OR image_bucket = 'store-qr'),
  image_path text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  version integer NOT NULL DEFAULT 1,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_qr_configs_loc_purpose_uniq UNIQUE (location_id, purpose),
  CONSTRAINT store_qr_configs_image_pair CHECK ((image_bucket IS NULL) = (image_path IS NULL)),
  CONSTRAINT store_qr_configs_active_has_source CHECK (status <> 'active' OR target_url IS NOT NULL OR image_path IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_qr_configs TO authenticated;
GRANT ALL ON public.store_qr_configs TO service_role;
REVOKE ALL ON public.store_qr_configs FROM anon;
ALTER TABLE public.store_qr_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY store_qr_configs_select ON public.store_qr_configs FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'hq_operator')
  OR EXISTS (SELECT 1 FROM public.user_location_perms p WHERE p.user_id = auth.uid() AND p.location_id = store_qr_configs.location_id)
);
CREATE POLICY store_qr_configs_admin_write ON public.store_qr_configs FOR ALL TO authenticated
USING (public.has_role(auth.uid(),'super_admin'))
WITH CHECK (public.has_role(auth.uid(),'super_admin'));

CREATE OR REPLACE FUNCTION public.store_qr_configs_bump_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.target_url, NEW.image_bucket, NEW.image_path, NEW.status)
     IS DISTINCT FROM (OLD.target_url, OLD.image_bucket, OLD.image_path, OLD.status) THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  ELSE
    NEW.version := OLD.version;
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_store_qr_configs_version BEFORE UPDATE ON public.store_qr_configs
FOR EACH ROW EXECUTE FUNCTION public.store_qr_configs_bump_version();