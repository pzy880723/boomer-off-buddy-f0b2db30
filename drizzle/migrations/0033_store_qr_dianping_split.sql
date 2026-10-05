-- 大众点评打卡码/评价码拆分：新增 dianping_checkin / dianping_review；历史 dianping（新天地实为评价码）改为 dianping_review，保留原对象路径。
-- 回滚：UPDATE ... SET purpose='dianping' WHERE purpose='dianping_review' AND split_part(image_path,'/',2)='dianping'; 恢复 0022 约束。
ALTER TABLE public.store_qr_configs DROP CONSTRAINT store_qr_configs_purpose_check;
ALTER TABLE public.store_qr_configs ADD CONSTRAINT store_qr_configs_purpose_check
  CHECK (purpose IN ('wechat_follow','wecom_contact','mini_program','storefront','xiaohongshu','dianping','dianping_checkin','dianping_review','identify'));
UPDATE public.store_qr_configs c SET purpose = 'dianping_review'
 WHERE c.purpose = 'dianping'
   AND NOT EXISTS (SELECT 1 FROM public.store_qr_configs x WHERE x.location_id = c.location_id AND x.purpose = 'dianping_review');
COMMENT ON TABLE public.store_qr_configs IS 'purpose dianping is DEPRECATED: legacy rows migrated to dianping_review; checkin and review are independent';