-- 虚构测试数据（仅隔离库）：1 门店、1 自营孤品、库存1、已发布 listing、1 顾客。
SET search_path=public,extensions;
INSERT INTO inv_locations(id,kind,name,is_active) VALUES ('11111111-1111-1111-1111-111111111111','shop','测试店',true);
INSERT INTO inv_skus(id,category,epc,name,price_tier,sales_state,sale_ownership,status,kind,sku_scope,inventory_policy,is_display)
 VALUES ('22222222-2222-2222-2222-222222222222','toy','EPCT1','测试品',100,'active','owned','active','single','custom','tracked',true);
INSERT INTO inv_stocks(sku_id,location_id,qty) VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',1);
INSERT INTO commerce_listings(id,sku_id,location_id,title,price,status,product_type)
 VALUES ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','测试品',100,'published','custom');
INSERT INTO commerce_customers(id,external_subject,status) VALUES ('44444444-4444-4444-4444-444444444444','test:1','active');
