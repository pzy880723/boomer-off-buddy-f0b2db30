-- 在“生产结构快照（仅结构，无数据）”上调用**真实**4个下单函数 + 0117/0118 包装与触发器。
-- 只使用本文件插入的虚构测试数据；运行在隔离本地集群。
\set ON_ERROR_STOP 1
SET search_path=public,extensions;
UPDATE inv_skus SET is_display=true WHERE id='22222222-2222-2222-2222-222222222222';

CREATE OR REPLACE FUNCTION pg_temp.args(fn text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE c uuid:='44444444-4444-4444-4444-444444444444'; it jsonb:='[{"listing_id":"33333333-3333-3333-3333-333333333333","quantity":1}]';
  q jsonb; base jsonb;
BEGIN
  base := jsonb_build_object('p_customer_id',c,'p_idempotency_key','k-'||fn||'-'||gen_random_uuid(),'p_items',it,
    'p_recipient_name','测试','p_recipient_phone','13800000000','p_customer_note',null,
    'p_merchant_id','1234567','p_app_id','wx0123456789abcdef','p_owned_location_ids',jsonb_build_array('11111111-1111-1111-1111-111111111111'));
  IF fn='commerce_create_ordinary_order' THEN
    q := commerce_quote_checkout(c,it,null);
    RETURN base || jsonb_build_object('p_shipping_address',jsonb_build_object('city','上海'),'p_courier_provider','platform',
      'p_courier_service_code','PLATFORM_RECOMMENDED','p_courier_service_name','平台','p_shipping_fee',(q->>'shipping_fee_fen')::numeric/100,'p_quote_snapshot',q);
  ELSIF fn='commerce_create_ordinary_pickup_order' THEN
    RETURN base || jsonb_build_object('p_quote_snapshot',commerce_quote_checkout_v2(c,it,null,'pickup'));
  ELSIF fn='commerce_create_ordinary_flash_order' THEN
    RETURN base || jsonb_build_object('p_shipping_address',jsonb_build_object('city','上海'),'p_quote_snapshot',commerce_quote_checkout_v2(c,it,null,'flash'));
  ELSE
    RETURN jsonb_build_object('p_user_id',c,'p_idempotency_key','k-v2-'||gen_random_uuid(),'p_items',it,'p_recipient_name','测试',
      'p_recipient_phone','13800000000','p_shipping_address',jsonb_build_object('city','上海'),'p_courier_provider','platform',
      'p_courier_service_code','PLATFORM_RECOMMENDED','p_courier_service_name','平台','p_shipping_fee',0,'p_quote_snapshot',null,'p_customer_note',null);
  END IF;
END $$;

-- 成功也回滚（抛哨兵异常），保证每个用例互不影响；返回 ok 或错误信息。
CREATE OR REPLACE FUNCTION pg_temp.try(ch text, fn text, direct boolean DEFAULT false) RETURNS text LANGUAGE plpgsql AS $$
DECLARE a jsonb := pg_temp.args(fn); m text;
BEGIN
  BEGIN
    IF direct THEN
      IF fn='commerce_create_ordinary_order' THEN
        PERFORM commerce_create_ordinary_order((a->>'p_customer_id')::uuid,a->>'p_idempotency_key',a->'p_items',a->>'p_recipient_name',
          a->>'p_recipient_phone',a->'p_shipping_address',a->>'p_courier_provider',a->>'p_courier_service_code',a->>'p_courier_service_name',
          (a->>'p_shipping_fee')::numeric,a->'p_quote_snapshot',null,a->>'p_merchant_id',a->>'p_app_id',ARRAY['11111111-1111-1111-1111-111111111111']::uuid[]);
      ELSIF fn='commerce_create_ordinary_pickup_order' THEN
        PERFORM commerce_create_ordinary_pickup_order((a->>'p_customer_id')::uuid,a->>'p_idempotency_key',a->'p_items',a->>'p_recipient_name',
          a->>'p_recipient_phone',a->'p_quote_snapshot',null,a->>'p_merchant_id',a->>'p_app_id',ARRAY['11111111-1111-1111-1111-111111111111']::uuid[]);
      ELSIF fn='commerce_create_ordinary_flash_order' THEN
        PERFORM commerce_create_ordinary_flash_order((a->>'p_customer_id')::uuid,a->>'p_idempotency_key',a->'p_items',a->>'p_recipient_name',
          a->>'p_recipient_phone',a->'p_shipping_address',a->'p_quote_snapshot',null,a->>'p_merchant_id',a->>'p_app_id',ARRAY['11111111-1111-1111-1111-111111111111']::uuid[]);
      ELSE
        PERFORM commerce_create_order_v2((a->>'p_user_id')::uuid,a->>'p_idempotency_key',a->'p_items',a->>'p_recipient_name',a->>'p_recipient_phone',
          a->'p_shipping_address','platform','PLATFORM_RECOMMENDED','平台',0,null,null);
      END IF;
    ELSE
      PERFORM commerce_create_order_in_channel(ch, fn, a);
    END IF;
    RAISE EXCEPTION 'SENTINEL_OK';
  EXCEPTION WHEN OTHERS THEN m := SQLERRM;
  END;
  RETURN CASE WHEN m='SENTINEL_OK' THEN 'ok' ELSE m END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.policy(mini boolean, app boolean) RETURNS void LANGUAGE sql AS $$
  DELETE FROM sku_sales_channel_intents;
  INSERT INTO sku_sales_channel_intents(sku_id,location_id,channel,enabled,version,op_id,updated_by)
  SELECT '22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',c,e,1,gen_random_uuid(),gen_random_uuid()
  FROM (VALUES ('miniapp',mini),('app',app)) v(c,e) WHERE e IS NOT NULL;
$$;

DO $$
DECLARE fn text; r text; fails int := 0;
  fns text[] := ARRAY['commerce_create_ordinary_order','commerce_create_ordinary_pickup_order','commerce_create_ordinary_flash_order','commerce_create_order_v2'];
  PROCEDURE_NOOP int;
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    -- 基线：无策略时 4 入口都能真实下单（证明夹具有效，否则后续“拒绝”无意义）
    PERFORM pg_temp.policy(null,null);
    r := pg_temp.try('unknown',fn); IF r<>'ok' THEN RAISE EXCEPTION '[%] baseline unknown should succeed: %',fn,r; END IF;
    r := pg_temp.try(null,fn,true); IF r<>'ok' THEN RAISE EXCEPTION '[%] baseline direct should succeed: %',fn,r; END IF;
    -- 小程序关、APP开
    PERFORM pg_temp.policy(false,true);
    r := pg_temp.try('miniapp',fn); IF r<>'sales channel disabled' THEN RAISE EXCEPTION '[%] mini-off miniapp: %',fn,r; END IF;
    r := pg_temp.try('app',fn);     IF r<>'ok' THEN RAISE EXCEPTION '[%] mini-off app should succeed (GUC visible through SECURITY DEFINER): %',fn,r; END IF;
    r := pg_temp.try('unknown',fn); IF r<>'sales channel disabled' THEN RAISE EXCEPTION '[%] mini-off unknown: %',fn,r; END IF;
    r := pg_temp.try(null,fn,true); IF r<>'sales channel disabled' THEN RAISE EXCEPTION '[%] mini-off direct: %',fn,r; END IF;
    -- 反向：小程序开、APP关
    PERFORM pg_temp.policy(true,false);
    r := pg_temp.try('miniapp',fn); IF r<>'ok' THEN RAISE EXCEPTION '[%] app-off miniapp should succeed: %',fn,r; END IF;
    r := pg_temp.try('app',fn);     IF r<>'sales channel disabled' THEN RAISE EXCEPTION '[%] app-off app: %',fn,r; END IF;
    r := pg_temp.try('unknown',fn); IF r<>'sales channel disabled' THEN RAISE EXCEPTION '[%] app-off unknown: %',fn,r; END IF;
    r := pg_temp.try(null,fn,true); IF r<>'sales channel disabled' THEN RAISE EXCEPTION '[%] app-off direct: %',fn,r; END IF;
    RAISE NOTICE 'PASS real % : baseline ok; mini-off(mini✗ app✓ unknown✗ direct✗); app-off(mini✓ app✗ unknown✗ direct✗)', fn;
  END LOOP;
  PERFORM pg_temp.policy(null,null);
  r := pg_temp.try(null,'commerce_create_ordinary_order');
  IF r <> 'invalid sales channel' THEN RAISE EXCEPTION 'NULL channel must be rejected: %', r; END IF;
  r := pg_temp.try('app','commerce_create_order_with_fankuang_gifts');
  IF r <> 'gift_order_unavailable' THEN RAISE EXCEPTION 'gift must be unavailable: %', r; END IF;
  RAISE NOTICE 'PASS NULL channel rejected; fankuang gift -> gift_order_unavailable';
END $$;

-- 原子性：所有失败/回滚后没有残留订单、订单行、预占，库存与商品未改
SELECT CASE WHEN (SELECT count(*) FROM commerce_orders)=0 AND (SELECT count(*) FROM commerce_order_items)=0
  AND (SELECT count(*) FROM inventory_reservations)=0 AND (SELECT count(*) FROM inventory_reservation_lines)=0
  AND (SELECT qty FROM inv_stocks WHERE sku_id='22222222-2222-2222-2222-222222222222')=1
  AND (SELECT status FROM commerce_listings WHERE id='33333333-3333-3333-3333-333333333333')='published'
  THEN 'PASS atomic: 0 orders/items/reservations left, stock=1, listing published'
  ELSE 'FAIL atomic residue' END AS result;
