# 只读审查：「加入翻筐乐」开关（不改代码、不迁移、不发布）

## 一、上一项核查结论（透明抠图）
listing cfab8314 / sku 6b80ec84 没有透明版本。两张已修复图片 sku-listing/gallery/6b80ec84-…/{5de49fc1-…,bb40fdee-…}/….png 都是真 PNG，但 colorType=2（RGB，没有 alpha 通道），1024×1024，透明和半透明像素都是 0，四角为浅灰（约 215,216,215）。修图提示词（src/server/handheld-ai.server.ts 的 SYSTEM_LISTING_IMAGE）要求「背景统一为干净浅灰底」，只换背景，不抠图。存储里也没有任何 cutout 或 mask 对象和字段。要复用透明图，需要另外授权新建抠图任务。

## 二、现有字段（数据库实际读回）
- inv_skus：price_tier numeric、is_custom_price boolean 默认 false、ai_suggested_price；没有任何翻筐乐、标签或 flag 类字段。
- commerce_listings：price、compare_at_price；同样没有相关字段。
- 本仓库搜索不到「翻筐乐」或「价格<50」的筛选逻辑。小程序的「价格<50 OR 标签」不在这个仓库（Tencent 或小程序侧），这里看不到原实现。

## 三、函数签名（数据库实际读回）
- handheld_item_update(p_device_id uuid, p_user_id uuid, p_client_op_id text, p_location_id uuid, p_sku_id uuid, p_expected_updated_at timestamptz, p_patch jsonb, p_fingerprint text) → jsonb。来源迁移 0015_handheld_item_edit_delete_v2 和 0016_handheld_item_images。p_patch 白名单为 name、price_tier、notes、grade、image_paths（0016 第 40 行），其他键会被拒绝。函数会写 commerce_listings。
- handheld_smart_create_commit(p_device_id, p_user_id, p_client_op_id, p_fingerprint, p_location_id uuid, p_reuse boolean, p_sku jsonb, p_epcs text[], p_note text, p_release_shop_id uuid) → jsonb。来源迁移 0012_handheld_smart_create_idempotency。从 p_sku 读取 is_custom_price、inventory_policy，写入 inv_skus；不写 listing。handheld_smart_create_complete(p_op_id uuid, p_response jsonb) 只回写响应。
- search_inv_skus(p_query, p_primary_category, p_brand_ids uuid[], p_facet_codes text[], p_limit int, p_offset int) → TABLE(sku_id, search_rank)。
- 最新迁移编号为 0044_store_pickup_hardening，新迁移应为 0045。

## 四、现有入口
- PC 编辑：src/components/inventory/sku-edit-dialog.tsx 调用 updateSku（src/lib/inventory.functions.ts）。新建自定义商品：custom-sku-dialog.tsx。页面入口：inventory.skus.index.tsx、inventory.skus.$id.tsx、m.skus.$id.tsx。
- 上架同步：src/server/commerce-listing.server.ts 的 upsertCustomListingForSku，只处理 is_custom_price、非 unlimited、single，标准商品跳过（已满足「标准商品不进线上商城」）。
- 手持端：item-edit-schemas.ts 的 ItemPatchReq 为 strict 模式；handheld-item-edit.server.ts 负责把请求转成 patch。smart-create 的入参是 SmartCreateReq（src/lib/handheld/schemas）。
- 商城列表：src/routes/api/public/storefront/products.ts。流程为 search_inv_skus（上限 500）→ commerce_listings published → 富化 → 过滤 stock>0 → 计算 total → 切页，过滤已经发生在分页之前。查询参数由 parseStorefrontProductQuery 解析（storefront-products.server.ts:176），目前没有翻筐乐参数。详情页为 products.$id.ts。
- OpenAPI：src/lib/handheld/openapi.ts:401/415（StorefrontProductsQuery / StorefrontProductsRes / StorefrontProductRes）。

## 五、最小改动建议（等 Codex 确认后再实施）
1. 迁移 0045：在 inv_skus 新增 basket_override boolean NULL（null 表示自动），并加注释说明。有效值计算为 coalesce(basket_override, price_tier <= 49.9)。低价商品显式设为 false 后不会被价格回退重新纳入；高价商品显式设为 true 后不需要标签也能查到。不复制 SKU，不改库存、库位或有赞映射。
2. 0045 中用 CREATE OR REPLACE 重定义 handheld_item_update，把 basket_override（布尔或 null）加入 p_patch 白名单。handheld_smart_create_commit 从 p_sku 读取该值，并保持现有幂等指纹语义。
3. PC：updateSku 的 patch 白名单和 sku-edit-dialog、custom-sku-dialog 各加一行开关，标准商品不显示。默认值按售价显示，用户手动切换后才写入显式值。
4. 手持端：ItemPatchReq、SmartCreateReq、ItemPatchRes 的 changed_fields 加上 basket_override，并同步 OpenAPI。
5. 商城：在 parseStorefrontProductQuery 增加 basket=1；列表在 stock>0 过滤和分页之前按有效值过滤；列表和详情返回 in_basket 布尔。小程序改为使用 basket=1，不再自行用价格<50 OR 标签判断。

## 待确认
- 开关单行放在售价输入框下方（建议）。
- 字段名称和「49.9 含、50 不含」的边界。
