-- 扩展门店二维码用途以兼容 iOS 渠道（xiaohongshu/dianping/identify）；仅放宽 CHECK，不改数据。
-- ROLLBACK SQL（仅当无新用途行时）:
--   ALTER TABLE public.store_qr_configs DROP CONSTRAINT store_qr_configs_purpose_check;
--   ALTER TABLE public.store_qr_configs ADD CONSTRAINT store_qr_configs_purpose_check CHECK (purpose IN ('wechat_follow','wecom_contact','mini_program','storefront'));
ALTER TABLE public.store_qr_configs DROP CONSTRAINT store_qr_configs_purpose_check;
ALTER TABLE public.store_qr_configs ADD CONSTRAINT store_qr_configs_purpose_check
  CHECK (purpose IN ('wechat_follow','wecom_contact','mini_program','storefront','xiaohongshu','dianping','identify'));