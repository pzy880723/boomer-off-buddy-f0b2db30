-- 0070：尺寸素材登记事务 RPC（sku 行锁内复核 location/revision/实测宽高/actor 权限 + op 指纹 + first-write-wins）。
-- 回滚：DROP FUNCTION public.measurement_asset_register(uuid, uuid, text, uuid, integer, numeric, numeric, text, text, jsonb, integer, integer, numeric)。
CREATE OR REPLACE FUNCTION public.measurement_asset_register(
  p_sku_id uuid,
  p_actor_id uuid,
  p_client_op_id text,
  p_location_id uuid,
  p_revision integer,
  p_height_cm numeric,
  p_width_cm numeric,
  p_content_hash text,
  p_preview_path text,
  p_bbox jsonb,
  p_front_width_px integer,
  p_front_height_px integer,
  p_px_per_cm numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sku inv_skus%ROWTYPE;
  v_mut measurement_mutations%ROWTYPE;
  v_asset product_measurement_assets%ROWTYPE;
  v_fp jsonb;
  v_width numeric;
  v_result jsonb;
BEGIN
  IF p_client_op_id IS NULL OR length(p_client_op_id) < 8 OR length(p_client_op_id) > 128 THEN
    RAISE EXCEPTION 'client_op_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL OR p_location_id IS NULL OR p_revision IS NULL OR p_revision < 1 THEN
    RAISE EXCEPTION 'invalid_asset' USING ERRCODE = '22023';
  END IF;
  IF p_content_hash IS NULL OR p_content_hash !~ '^[0-9a-f]{16}$'
     OR p_preview_path IS DISTINCT FROM
        ('sku-listing/measurements/' || p_sku_id::text || '/' || p_revision::text || '-' || p_content_hash || '-640.png')
     OR p_bbox IS NULL OR p_front_width_px IS NULL OR p_front_width_px <= 0
     OR p_front_height_px IS NULL OR p_front_height_px <= 0
     OR p_px_per_cm IS NULL OR p_px_per_cm <= 0
     OR p_height_cm IS NULL OR p_height_cm <= 0 OR p_width_cm IS NULL OR p_width_cm <= 0 THEN
    RAISE EXCEPTION 'invalid_asset' USING ERRCODE = '22023';
  END IF;

  v_fp := jsonb_build_object(
    'kind', 'measurement_image', 'sku_id', p_sku_id, 'revision', p_revision,
    'content_hash', p_content_hash, 'location_id', p_location_id
  );

  SELECT * INTO v_sku FROM inv_skus WHERE id = p_sku_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  -- 当前 actor 权限（与 actorCanAccessLocation 一致：HQ 全通，其余须显式库位授权）
  IF NOT (
    EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_actor_id AND role::text IN ('super_admin','hq_operator'))
    OR EXISTS (SELECT 1 FROM user_location_perms WHERE user_id = p_actor_id AND location_id = v_sku.location_id)
  ) THEN
    RAISE EXCEPTION 'unauthorized_role' USING ERRCODE = '42501';
  END IF;

  -- 锁内幂等：同 actor+op 同图回放，换内容 op_conflict
  SELECT * INTO v_mut FROM measurement_mutations
   WHERE actor_id = p_actor_id AND client_op_id = p_client_op_id;
  IF FOUND THEN
    IF v_mut.fingerprint = v_fp THEN
      RETURN v_mut.result || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'op_conflict' USING ERRCODE = '40001';
  END IF;

  IF v_sku.location_id IS DISTINCT FROM p_location_id THEN
    RAISE EXCEPTION 'location_mismatch' USING ERRCODE = '42501';
  END IF;

  -- 版本与几何：必须绑定 SKU 当前实测版本，且服务端校验所用宽高等于当前实测值
  v_width := COALESCE(v_sku.measurement_width_cm, v_sku.measurement_diameter_cm);
  IF v_sku.measured_at IS NULL OR v_sku.measurement_revision <> p_revision
     OR v_sku.measurement_height_cm IS DISTINCT FROM p_height_cm
     OR v_width IS DISTINCT FROM p_width_cm THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;

  -- first-write-wins：同 revision 已有不同的 ready 图，拒绝覆盖
  SELECT * INTO v_asset FROM product_measurement_assets
   WHERE sku_id = p_sku_id AND revision = p_revision FOR UPDATE;
  IF FOUND AND v_asset.status = 'ready' AND v_asset.cutout_preview_path IS DISTINCT FROM p_preview_path THEN
    RAISE EXCEPTION 'image_conflict' USING ERRCODE = '40001';
  END IF;

  INSERT INTO product_measurement_assets
    (sku_id, revision, status, cutout_preview_path, bbox, front_width_px, front_height_px,
     px_per_cm, error, verified, width_cm, height_cm, updated_at)
  VALUES
    (p_sku_id, p_revision, 'ready', p_preview_path, p_bbox, p_front_width_px, p_front_height_px,
     p_px_per_cm, NULL, true, p_width_cm, p_height_cm, now())
  ON CONFLICT (sku_id, revision) DO UPDATE SET
    status = 'ready', cutout_preview_path = EXCLUDED.cutout_preview_path, bbox = EXCLUDED.bbox,
    front_width_px = EXCLUDED.front_width_px, front_height_px = EXCLUDED.front_height_px,
    px_per_cm = EXCLUDED.px_per_cm, error = NULL, verified = true,
    width_cm = EXCLUDED.width_cm, height_cm = EXCLUDED.height_cm, updated_at = now();

  v_result := jsonb_build_object(
    'status', 'ready', 'revision', p_revision, 'location_id', v_sku.location_id,
    'cutout_preview_path', p_preview_path, 'width_cm', p_width_cm, 'height_cm', p_height_cm,
    'replayed', false
  );

  INSERT INTO measurement_mutations
    (actor_id, client_op_id, sku_id, location_id, expected_revision, fingerprint, result)
  VALUES
    (p_actor_id, p_client_op_id, p_sku_id, v_sku.location_id, p_revision, v_fp, v_result);

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.measurement_asset_register(uuid, uuid, text, uuid, integer, numeric, numeric, text, text, jsonb, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.measurement_asset_register(uuid, uuid, text, uuid, integer, numeric, numeric, text, text, jsonb, integer, integer, numeric) TO service_role;
