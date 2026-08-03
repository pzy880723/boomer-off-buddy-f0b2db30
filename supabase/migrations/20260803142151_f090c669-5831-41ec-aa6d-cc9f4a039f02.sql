CREATE TEMP TABLE tmp_desired_roots(code text primary key, name text, sort_order int) ON COMMIT DROP;
CREATE TEMP TABLE tmp_desired_children(code text primary key, name text, root_code text, sort_order int) ON COMMIT DROP;

INSERT INTO tmp_desired_roots(code, name, sort_order) VALUES
  ('porcelain_jp', '日本瓷器', 10),
  ('porcelain_eu', '欧洲瓷器', 20),
  ('toy_model', '玩具模型', 30),
  ('character_ip_goods', '角色周边', 40),
  ('audio_media', '唱片影音', 50),
  ('digital_appliance', '数码家电', 60),
  ('game_device', '游戏设备', 70),
  ('home_goods', '家居杂货', 80),
  ('stationery_publication', '文具书刊', 90),
  ('fashion_wearable', '服饰穿戴', 100),
  ('fashion_jewelry', '珠宝首饰', 110),
  ('art_collectible', '古美术', 120),
  ('daily_misc', '日用杂货', 130);

INSERT INTO tmp_desired_children(code, name, root_code, sort_order) VALUES
  ('porcelain_drinkware', '散瓷杯具', 'porcelain_jp', 1),
  ('porcelain_tableware', '散瓷盘碗', 'porcelain_jp', 2),
  ('porcelain_serveware', '散瓷壶/酒器', 'porcelain_jp', 3),
  ('porcelain_vase_planter', '花器/摆件', 'porcelain_jp', 4),
  ('porcelain_other', '其他散瓷', 'porcelain_jp', 5),
  ('porcelain_jp_set', '套装/礼盒', 'porcelain_jp', 6),
  ('eu_porcelain_cup', '散瓷杯碟', 'porcelain_eu', 1),
  ('eu_porcelain_plate', '散瓷盘碗', 'porcelain_eu', 2),
  ('eu_porcelain_pot', '散瓷壶罐', 'porcelain_eu', 3),
  ('eu_porcelain_vase', '花瓶/摆件', 'porcelain_eu', 4),
  ('eu_porcelain_other', '其他散瓷', 'porcelain_eu', 5),
  ('eu_porcelain_set', '套装/礼盒', 'porcelain_eu', 6),
  ('toy_plush', '毛绒玩具', 'toy_model', 1),
  ('toy_character_figure', '人偶/公仔', 'toy_model', 2),
  ('toy_building_model', '模型/机械玩具', 'toy_model', 3),
  ('toy_board_card', '桌游/卡牌', 'toy_model', 4),
  ('toy_capsule_mini', '扭蛋/食玩', 'toy_model', 5),
  ('toy_other', '其他玩具', 'toy_model', 6),
  ('character_badge', '徽章/亚克力', 'character_ip_goods', 1),
  ('character_paper', '纸品/卡片', 'character_ip_goods', 2),
  ('character_plush', '毛绒/布艺', 'character_ip_goods', 3),
  ('character_charm', '挂件/小物', 'character_ip_goods', 4),
  ('character_other', '其他周边', 'character_ip_goods', 5),
  ('audio_vinyl', '黑胶唱片', 'audio_media', 1),
  ('audio_cd', 'CD/MD', 'audio_media', 2),
  ('audio_cassette', '磁带', 'audio_media', 3),
  ('audio_video_disc', '录像带/影碟', 'audio_media', 4),
  ('audio_instrument', '乐器/音乐器材', 'audio_media', 5),
  ('audio_merchandise', '音乐周边', 'audio_media', 6),
  ('digital_camera', '相机/摄像', 'digital_appliance', 1),
  ('digital_audio_player', '音响/播放器', 'digital_appliance', 2),
  ('digital_communication', '手机/通讯', 'digital_appliance', 3),
  ('digital_computer_office', '电脑/办公', 'digital_appliance', 4),
  ('digital_small_appliance', '生活小家电', 'digital_appliance', 5),
  ('digital_accessory', '配件/耗材', 'digital_appliance', 6),
  ('game_handheld', '掌机', 'game_device', 1),
  ('game_desktop_console', '桌面游戏机', 'game_device', 2),
  ('game_cartridge', '卡带', 'game_device', 3),
  ('game_accessory', '其他配件', 'game_device', 4),
  ('tableware_glass', '玻璃器皿', 'home_goods', 1),
  ('home_metal_enamel', '金属/搪瓷器皿', 'home_goods', 2),
  ('home_wood_plastic', '木竹/塑料器皿', 'home_goods', 3),
  ('home_lighting_clock', '灯具/钟表', 'home_goods', 4),
  ('home_vase_ornament', '花器/摆件', 'home_goods', 5),
  ('home_storage_decor', '收纳/装饰', 'home_goods', 6),
  ('home_small_furniture', '小型家具', 'home_goods', 7),
  ('publication_book', '书籍/杂志', 'stationery_publication', 1),
  ('stationery_desk', '文具/书写工具', 'stationery_publication', 2),
  ('stationery_notebook', '本册/纸品', 'stationery_publication', 3),
  ('publication_poster', '海报/印刷品', 'stationery_publication', 4),
  ('publication_postcard_ticket', '票证/明信片', 'stationery_publication', 5),
  ('fashion_clothing', '服装', 'fashion_wearable', 1),
  ('fashion_shoes', '鞋靴', 'fashion_wearable', 2),
  ('fashion_bag', '包袋', 'fashion_wearable', 3),
  ('fashion_hat_scarf', '帽子/围巾', 'fashion_wearable', 4),
  ('fashion_eyewear', '眼镜', 'fashion_wearable', 5),
  ('fashion_watch', '腕表', 'fashion_wearable', 6),
  ('fashion_accessory_other', '其他配饰', 'fashion_wearable', 7),
  ('jewelry_necklace', '项链/吊坠', 'fashion_jewelry', 1),
  ('jewelry_ring', '戒指', 'fashion_jewelry', 2),
  ('jewelry_bracelet', '手链/手镯', 'fashion_jewelry', 3),
  ('jewelry_earring', '耳饰', 'fashion_jewelry', 4),
  ('jewelry_brooch', '胸针/别针', 'fashion_jewelry', 5),
  ('jewelry_stone_bead', '裸石/串珠', 'fashion_jewelry', 6),
  ('jewelry_other', '其他首饰', 'fashion_jewelry', 7),
  ('art_painting', '书画', 'art_collectible', 1),
  ('art_lacquer', '漆器', 'art_collectible', 2),
  ('art_metalwork', '金工', 'art_collectible', 3),
  ('art_sculpture', '木雕/雕塑', 'art_collectible', 4),
  ('art_tea_utensil', '茶道具', 'art_collectible', 5),
  ('art_curio_misc', '古玩杂项', 'art_collectible', 6),
  ('daily_food', '食品/饮料', 'daily_misc', 1),
  ('daily_cleaning', '清洁/护理', 'daily_misc', 2),
  ('daily_beauty_fragrance', '美妆/香氛', 'daily_misc', 3),
  ('daily_hardware_tool', '工具/五金', 'daily_misc', 4),
  ('daily_travel_outdoor', '旅行/户外', 'daily_misc', 5),
  ('daily_pet', '宠物用品', 'daily_misc', 6),
  ('daily_other', '其他生活小物', 'daily_misc', 7);

INSERT INTO public.inv_categories(code, name, parent_id, sort_order, is_active, is_system, kind)
SELECT code, name, NULL, sort_order, true, false, 'group' FROM tmp_desired_roots
ON CONFLICT (code) DO UPDATE
  SET name = excluded.name,
      parent_id = NULL,
      sort_order = excluded.sort_order,
      is_active = true,
      updated_at = now();

INSERT INTO public.inv_categories(code, name, parent_id, sort_order, is_active, is_system, kind)
SELECT child.code, child.name, root.id, root.sort_order + child.sort_order, true, false, 'category'
  FROM tmp_desired_children child
  JOIN public.inv_categories root ON root.code = child.root_code
ON CONFLICT (code) DO UPDATE
  SET name = excluded.name,
      parent_id = excluded.parent_id,
      sort_order = excluded.sort_order,
      is_active = true,
      kind = 'category',
      updated_at = now();

UPDATE public.inv_categories
   SET is_active = false, updated_at = now()
 WHERE is_active
   AND code NOT IN (SELECT code FROM tmp_desired_roots)
   AND code NOT IN (SELECT code FROM tmp_desired_children)
   AND code NOT IN ('classification_pending', 'ai_low_confidence', 'new_category_candidate', 'compliance_review');

UPDATE public.inv_categories
   SET is_system = true, is_active = true, updated_at = now()
 WHERE code IN ('classification_pending', 'ai_low_confidence', 'new_category_candidate', 'compliance_review');

CREATE TEMP TABLE tmp_standard_groups(category text primary key, name text, epc_code text, sort_order int) ON COMMIT DROP;
INSERT INTO tmp_standard_groups(category, name, epc_code, sort_order) VALUES
  ('porcelain_jp', '日本瓷器', 'JP', 10),
  ('porcelain_eu', '欧洲瓷器', 'EU', 20),
  ('toy_model', '玩具模型', 'TY', 30),
  ('character_ip_goods', '角色周边', 'AN', 40),
  ('audio_media', '唱片影音', 'MD', 50),
  ('digital_appliance', '数码家电', 'DG', 60),
  ('game_device', '游戏设备', 'GM', 70),
  ('home_goods', '家居杂货', 'HM', 80),
  ('stationery_publication', '文具书刊', 'SP', 90),
  ('fashion_wearable', '服饰穿戴', 'FS', 100),
  ('fashion_jewelry', '珠宝首饰', 'JW', 110),
  ('art_collectible', '古美术', 'AT', 120),
  ('daily_misc', '日用杂货', 'DL', 130);

CREATE TEMP TABLE tmp_group_renames(from_category text, from_name text, to_category text, to_name text) ON COMMIT DROP;
INSERT INTO tmp_group_renames VALUES
  ('porcelain', '日本散瓷', 'porcelain_jp', '日本瓷器'),
  ('porcelain', '欧洲散瓷', 'porcelain_eu', '欧洲瓷器'),
  ('toy_model', '毛绒玩偶', 'toy_model', '玩具模型'),
  ('character_ip_goods', '二次元周边', 'character_ip_goods', '角色周边'),
  ('audio_media', '音像制品', 'audio_media', '唱片影音'),
  ('fashion_wearable', '时尚配件', 'fashion_wearable', '服饰穿戴');

UPDATE public.inv_skus sku
   SET category = rename.to_category,
       name = rename.to_name,
       updated_at = now()
  FROM tmp_group_renames rename
 WHERE sku.kind = 'single'
   AND sku.is_custom_price = false
   AND sku.category = rename.from_category
   AND sku.name = rename.from_name
   AND NOT EXISTS (
     SELECT 1 FROM public.inv_skus other
      WHERE other.category = rename.to_category
        AND other.name = rename.to_name
        AND other.price_tier = sku.price_tier
        AND other.id <> sku.id
   );

UPDATE public.inv_skus sku
   SET status = 'archived',
       is_display = false,
       updated_at = now()
 WHERE sku.kind = 'single'
   AND sku.is_custom_price = false
   AND sku.inventory_policy = 'unlimited'
   AND NOT EXISTS (
     SELECT 1 FROM tmp_standard_groups grp
      WHERE grp.category = sku.category AND grp.name = sku.name
   );

DO $$
DECLARE
  v_price_tiers numeric[] := ARRAY[
    6.9, 9.9, 15.9, 19.9, 29.9, 39.9, 49.9, 59.9, 69, 79, 89, 99, 129, 159,
    199, 259, 299, 359, 399, 459, 499, 580, 680, 780, 880, 980, 1080, 1180,
    1280, 1380, 1580
  ]::numeric[];
  v_total integer;
BEGIN
  IF array_length(v_price_tiers, 1) <> 31 THEN
    RAISE EXCEPTION 'standard catalog must contain exactly 31 price tiers';
  END IF;

  INSERT INTO public.inv_skus (
    category, name, sku_code, price_tier, is_custom_price, kind, epc,
    stock_qty, status, is_display, inventory_policy, sku_scope, default_shop_ids
  )
  SELECT
    grp.category,
    grp.name,
    'SKU-STD-' || grp.epc_code,
    tier.price,
    false,
    'single',
    'STD-' || grp.epc_code || '-' || lpad((tier.price * 10)::integer::text, 5, '0') || '-' ||
      upper(substr(md5(grp.category || '|' || grp.name), 1, 8)),
    0,
    'active',
    true,
    'unlimited',
    'standard',
    ARRAY[]::uuid[]
  FROM tmp_standard_groups grp
  CROSS JOIN unnest(v_price_tiers) AS tier(price)
  ON CONFLICT (category, price_tier, name) DO UPDATE
    SET status = 'active',
        is_display = true,
        inventory_policy = 'unlimited',
        kind = 'single',
        is_custom_price = false,
        updated_at = now();

  SELECT count(*) INTO v_total
    FROM public.inv_skus sku
    JOIN tmp_standard_groups grp ON grp.category = sku.category AND grp.name = sku.name
   WHERE sku.kind = 'single'
     AND sku.is_custom_price = false
     AND sku.inventory_policy = 'unlimited'
     AND sku.is_display
     AND sku.status = 'active';
  IF v_total <> 403 THEN
    RAISE EXCEPTION 'standard catalog must contain exactly 403 SKUs, found %', v_total;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.inv_skus sku
      JOIN tmp_standard_groups grp ON grp.category = sku.category AND grp.name = sku.name
     WHERE sku.kind = 'single' AND sku.is_custom_price = false AND sku.status = 'active'
     GROUP BY sku.category, sku.name
    HAVING count(DISTINCT sku.price_tier) <> 31
  ) THEN
    RAISE EXCEPTION 'every standard product group must contain exactly 31 price tiers';
  END IF;

  INSERT INTO public.app_settings(key, value, updated_at)
  VALUES ('inv_price_tiers', to_jsonb(v_price_tiers), now())
  ON CONFLICT (key) DO UPDATE
    SET value = excluded.value, updated_at = excluded.updated_at;
END $$;

ALTER TABLE public.commerce_order_items
  ADD COLUMN IF NOT EXISTS category_code text,
  ADD COLUMN IF NOT EXISTS category_name_snapshot text,
  ADD COLUMN IF NOT EXISTS subcategory_code text,
  ADD COLUMN IF NOT EXISTS subcategory_name_snapshot text;

ALTER TABLE public.pos_held_cart_items
  ADD COLUMN IF NOT EXISTS subcategory_code text,
  ADD COLUMN IF NOT EXISTS subcategory_name text;

ALTER TABLE public.pos_held_cart_items
  DROP CONSTRAINT IF EXISTS pos_held_cart_items_held_cart_id_sku_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS pos_held_cart_items_line_key
  ON public.pos_held_cart_items (held_cart_id, sku_id, coalesce(subcategory_code, ''));

CREATE OR REPLACE FUNCTION public.pos_complete_sale(
  p_shift_id uuid,
  p_operator_id uuid,
  p_client_op_id text,
  p_items jsonb,
  p_tenders jsonb,
  p_customer_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_shift public.pos_shifts;
  v_order public.commerce_orders;
  v_sku public.inv_skus;
  v_item record;
  v_component record;
  v_tender record;
  v_stock integer;
  v_available integer;
  v_required integer;
  v_unit_price numeric;
  v_subtotal numeric := 0;
  v_tender_total numeric := 0;
  v_payment_id uuid;
  v_receipt_no text;
  v_category_name text;
  v_subcategory_name text;
  v_items_payload jsonb;
BEGIN
  IF p_client_op_id IS NULL OR btrim(p_client_op_id) = '' THEN
    RAISE EXCEPTION 'client operation id is required';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'sale requires at least one item';
  END IF;
  IF jsonb_typeof(p_tenders) <> 'array' OR jsonb_array_length(p_tenders) = 0 THEN
    RAISE EXCEPTION 'sale requires at least one tender';
  END IF;

  SELECT * INTO v_order
    FROM public.commerce_orders
   WHERE source_channel = 'pos'
     AND idempotency_key = p_client_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'order_no', v_order.order_no,
      'replayed', true,
      'total_amount', v_order.total_amount
    );
  END IF;

  SELECT * INTO v_shift
    FROM public.pos_shifts
   WHERE id = p_shift_id
   FOR UPDATE;
  IF NOT FOUND OR v_shift.status <> 'open' THEN RAISE EXCEPTION 'POS shift is not open'; END IF;
  IF v_shift.operator_id <> p_operator_id THEN RAISE EXCEPTION 'POS shift belongs to another operator'; END IF;

  FOR v_item IN
    SELECT (elem->>'sku_id')::uuid AS sku_id, sum((elem->>'quantity')::integer) AS quantity
      FROM jsonb_array_elements(p_items) AS elem
     GROUP BY 1
     ORDER BY 1
  LOOP
    IF v_item.sku_id IS NULL OR v_item.quantity IS NULL OR v_item.quantity < 1 OR v_item.quantity > 999 THEN
      RAISE EXCEPTION 'sale item quantity is invalid';
    END IF;
    SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_item.sku_id FOR UPDATE;
    IF NOT FOUND OR v_sku.status <> 'active' OR NOT v_sku.is_display THEN
      RAISE EXCEPTION 'SKU % is not sellable', v_item.sku_id;
    END IF;
    IF v_sku.kind = 'single' AND v_sku.is_custom_price AND v_item.quantity <> 1 THEN
      RAISE EXCEPTION 'custom SKU quantity must be one';
    END IF;
    v_available := public.sales_sku_available_qty(v_sku.id, v_shift.location_id);
    IF v_available < v_item.quantity THEN
      RAISE EXCEPTION 'SKU % has insufficient available stock', v_sku.id;
    END IF;
    v_subtotal := v_subtotal + v_sku.price_tier * v_item.quantity;
  END LOOP;

  FOR v_tender IN
    SELECT tender.provider, tender.amount, tender.provider_transaction_id
      FROM jsonb_to_recordset(p_tenders)
        AS tender(provider text, amount numeric, provider_transaction_id text)
  LOOP
    IF v_tender.provider NOT IN ('cash','wechat','alipay','bank_card','store_credit','manual') THEN
      RAISE EXCEPTION 'unsupported tender provider';
    END IF;
    IF v_tender.amount IS NULL OR v_tender.amount <= 0 THEN
      RAISE EXCEPTION 'tender amount is invalid';
    END IF;
    v_tender_total := v_tender_total + v_tender.amount;
  END LOOP;
  IF round(v_tender_total, 2) <> round(v_subtotal, 2) THEN
    RAISE EXCEPTION 'tender total does not match sale total';
  END IF;

  INSERT INTO public.commerce_orders (
    user_id, source_channel, fulfillment_method, sale_location_id, operator_id,
    customer_id, pos_shift_id, payment_status, order_status, subtotal,
    total_amount, recipient_name, recipient_phone, shipping_address,
    courier_provider, courier_service_code, idempotency_key,
    reservation_expires_at, paid_at, completed_at, customer_note
  ) VALUES (
    NULL, 'pos', 'carryout', v_shift.location_id, p_operator_id,
    p_customer_id, p_shift_id, 'paid', 'completed', v_subtotal,
    v_subtotal, NULL, NULL, NULL, NULL, NULL, p_client_op_id,
    now(), now(), now(), p_note
  ) RETURNING * INTO v_order;

  FOR v_item IN
    SELECT (elem->>'sku_id')::uuid AS sku_id,
           (elem->>'quantity')::integer AS quantity,
           nullif(btrim(coalesce(elem->>'subcategory_code', '')), '') AS subcategory_code,
           ord
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(elem, ord)
     ORDER BY ord
  LOOP
    SELECT * INTO v_sku FROM public.inv_skus WHERE id = v_item.sku_id FOR UPDATE;
    v_unit_price := v_sku.price_tier;

    SELECT name INTO v_category_name FROM public.inv_categories WHERE code = v_sku.category;

    v_subcategory_name := NULL;
    IF v_item.subcategory_code IS NOT NULL THEN
      SELECT child.name INTO v_subcategory_name
        FROM public.inv_categories child
        JOIN public.inv_categories root ON root.id = child.parent_id
       WHERE child.code = v_item.subcategory_code
         AND child.is_active
         AND root.code = v_sku.category;
      IF v_subcategory_name IS NULL THEN
        RAISE EXCEPTION 'subcategory % is not valid for SKU %', v_item.subcategory_code, v_sku.id;
      END IF;
    END IF;

    INSERT INTO public.commerce_order_items (
      order_id, listing_id, sku_id, location_id, epc, title_snapshot,
      image_snapshot, condition_snapshot, unit_price, quantity, line_total,
      category_code, category_name_snapshot, subcategory_code, subcategory_name_snapshot
    )
    VALUES (
      v_order.id, NULL, v_sku.id, v_shift.location_id,
      CASE WHEN v_sku.kind = 'single' AND v_sku.is_custom_price THEN v_sku.epc ELSE NULL END,
      v_sku.name, v_sku.image_url, v_sku.grade, v_unit_price, v_item.quantity,
      v_unit_price * v_item.quantity,
      v_sku.category, coalesce(v_category_name, v_sku.category),
      v_item.subcategory_code, v_subcategory_name
    );

    IF v_sku.kind = 'bundle' THEN
      IF jsonb_typeof(v_sku.bundle_items) <> 'array' OR jsonb_array_length(v_sku.bundle_items) = 0 THEN
        RAISE EXCEPTION 'bundle SKU % has no components', v_sku.id;
      END IF;
      FOR v_component IN
        SELECT component.sku_id, component.qty
          FROM jsonb_to_recordset(v_sku.bundle_items) AS component(sku_id uuid, qty integer)
         ORDER BY component.sku_id
      LOOP
        v_required := v_item.quantity * v_component.qty;
        SELECT qty INTO v_stock
          FROM public.inv_stocks
         WHERE sku_id = v_component.sku_id AND location_id = v_shift.location_id
         FOR UPDATE;
        IF coalesce(v_stock, 0) < v_required THEN
          RAISE EXCEPTION 'bundle component % is out of stock', v_component.sku_id;
        END IF;
        PERFORM public.inv_apply_movement(
          v_component.sku_id, v_shift.location_id, -v_required,
          'pos_sale', v_order.id, NULL, p_client_op_id
        );
      END LOOP;
    ELSIF v_sku.inventory_policy = 'unlimited' THEN
      NULL;
    ELSE
      SELECT qty INTO v_stock
        FROM public.inv_stocks
       WHERE sku_id = v_sku.id AND location_id = v_shift.location_id
       FOR UPDATE;
      IF coalesce(v_stock, 0) < v_item.quantity THEN
        RAISE EXCEPTION 'SKU % is out of stock', v_sku.id;
      END IF;
      PERFORM public.inv_apply_movement(
        v_sku.id, v_shift.location_id, -v_item.quantity,
        'pos_sale', v_order.id,
        CASE WHEN v_sku.is_custom_price THEN v_sku.epc ELSE NULL END,
        p_client_op_id
      );
      IF v_sku.is_custom_price THEN
        UPDATE public.inv_skus SET sales_state = 'sold', updated_at = now() WHERE id = v_sku.id;
        UPDATE public.inv_epcs SET status = 'sold', current_location_id = NULL, last_seen_at = now()
         WHERE epc = v_sku.epc;
        UPDATE public.commerce_listings SET status = 'sold', sold_at = now(), updated_at = now()
         WHERE sku_id = v_sku.id AND status IN ('published', 'reserved');
      END IF;
    END IF;
  END LOOP;

  FOR v_tender IN
    SELECT tender.provider, tender.amount, tender.provider_transaction_id
      FROM jsonb_to_recordset(p_tenders)
        AS tender(provider text, amount numeric, provider_transaction_id text)
  LOOP
    INSERT INTO public.commerce_payments (
      order_id, provider, status, amount, provider_transaction_id, idempotency_key, paid_at
    ) VALUES (
      v_order.id, v_tender.provider, 'succeeded', v_tender.amount,
      v_tender.provider_transaction_id, p_client_op_id || ':' || v_tender.provider, now()
    ) RETURNING id INTO v_payment_id;
    INSERT INTO public.commerce_payment_events (
      payment_id, provider, provider_event_id, event_type,
      signature_verified, payload, processing_status, processed_at
    ) VALUES (
      v_payment_id, v_tender.provider,
      coalesce(v_tender.provider_transaction_id, p_client_op_id || ':' || v_tender.provider),
      'pos_payment_succeeded', true,
      jsonb_build_object('amount', v_tender.amount, 'shift_id', p_shift_id),
      'processed', now()
    );
    IF v_tender.provider = 'cash' THEN
      INSERT INTO public.pos_cash_movements (shift_id, order_id, type, amount, reason, operator_id)
      VALUES (p_shift_id, v_order.id, 'sale', v_tender.amount, 'POS sale', p_operator_id);
    END IF;
  END LOOP;

  SELECT jsonb_agg(jsonb_build_object(
           'sku_id', item.sku_id,
           'title', item.title_snapshot,
           'unit_price', item.unit_price,
           'quantity', item.quantity,
           'line_total', item.line_total,
           'category_code', item.category_code,
           'category_name', item.category_name_snapshot,
           'subcategory_code', item.subcategory_code,
           'subcategory_name', item.subcategory_name_snapshot
         ) ORDER BY item.created_at, item.id)
    INTO v_items_payload
    FROM public.commerce_order_items item
   WHERE item.order_id = v_order.id;

  v_receipt_no := (
    SELECT receipt_prefix FROM public.pos_registers WHERE id = v_shift.register_id
  ) || '-' || to_char(now(), 'YYYYMMDD') || '-' || right(v_order.order_no, 6);
  INSERT INTO public.pos_receipts (order_id, shift_id, receipt_no, payload)
  VALUES (
    v_order.id, p_shift_id, v_receipt_no,
    jsonb_build_object(
      'order_no', v_order.order_no,
      'receipt_no', v_receipt_no,
      'total_amount', v_order.total_amount,
      'paid_at', v_order.paid_at,
      'items', coalesce(v_items_payload, '[]'::jsonb)
    )
  );

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'order_no', v_order.order_no,
    'receipt_no', v_receipt_no,
    'replayed', false,
    'total_amount', v_order.total_amount,
    'items', coalesce(v_items_payload, '[]'::jsonb)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, text, jsonb, jsonb, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, text, jsonb, jsonb, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, text, jsonb, jsonb, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale(uuid, uuid, text, jsonb, jsonb, uuid, text) TO service_role;