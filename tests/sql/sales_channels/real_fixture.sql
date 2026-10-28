\set ON_ERROR_STOP 1
SET search_path=public,extensions;
INSERT INTO inv_locations(id,kind,name,is_active) VALUES ('11111111-1111-1111-1111-111111111111','shop','测试店',true);
INSERT INTO inv_skus(id,category,epc,name,price_tier,sales_state,sale_ownership,status,kind,sku_scope,inventory_policy)
 VALUES ('22222222-2222-2222-2222-222222222222','toy','EPCT1','测试品',100,'active','owned','active','single','custom','tracked');
INSERT INTO inv_stocks(sku_id,location_id,qty) VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',1);
INSERT INTO commerce_listings(id,sku_id,location_id,title,price,status,product_type)
