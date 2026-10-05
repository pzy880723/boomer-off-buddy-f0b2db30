-- 0029: 资产收件箱/观察快照只允许总部经 RLS 只读；去掉默认继承的 anon 权限和 authenticated 写权限。
REVOKE ALL ON public.youzan_member_asset_observations FROM anon, PUBLIC;
REVOKE ALL ON public.youzan_member_asset_inbox FROM anon, PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.youzan_member_asset_observations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.youzan_member_asset_inbox FROM authenticated;
GRANT SELECT ON public.youzan_member_asset_observations TO authenticated;
GRANT SELECT ON public.youzan_member_asset_inbox TO authenticated;