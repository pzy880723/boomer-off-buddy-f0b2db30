# 只读核对：商品编辑字段（本仓库 + Lovable Cloud 源库）

本轮没有改代码、数据库、配置或密钥，没有发布，也没有调用模型或有赞。腾讯不是我部署的，以下也不推断腾讯状态。

## 1. 当前标识
- 本仓库 HEAD：`cca2b7d689b4eb0e93eb29683470ed1b752b7f2b`（2026-11-13T17:28:28Z）。
- 仓库里搜不到 A1804、A1806、A1808，这些是腾讯/本地流水，本仓库没有记录。

## 2. 商品编辑接口 GET/PATCH（`src/routes/api/public/handheld/items.$id.ts`）
- **GET**（第31行起）返回 `category`、`category_name`、`category_path`、`brand`、`era`（从 attributes 读取），以及 `brand_id`、`ip_name`、`facet_codes`。只读，不写数据。
- **PATCH**（第163行）调用 `handleItemPatch`，位于 `src/server/handheld-item-edit.server.ts:60`。
  - 字段定义 `ItemPatchReq` 在 `src/lib/handheld/item-edit-schemas.ts:24`，使用 `.strict()`。
  - 允许保存的字段只有：name、price_tier、description、condition_grade、image_paths、fankuang_override、featured_stamp、notice_tags。
  - 请求里带 `category`、`brand`、`ip_name`、`era`、`facet_codes` 会被拒绝，返回 422 validation_error。
  - **结论：本仓库 PATCH 不支持这5个字段。** 所以“省略不改、空数组清标签”在本仓库无从实现，也无从核实。
- 现有字段的保存机制：
  - 原子保存：通过单个数据库函数 `handheld_item_update` 完成。
  - CAS：用 `expected_updated_at` 防止覆盖别人的修改。
  - 幂等：用 `client_op_id` 加请求指纹，重复提交会标记 `replayed`。
  - 省略的字段不写入，因为第68–75行只拷贝请求里实际带了的字段。

## 3. 迁移与部署证据
- Lovable Cloud 源库实际只读结果：
  - `public.handheld_item_update` 只有一个版本，参数为 `(device_id, user_id, client_op_id, location_id, sku_id, expected_updated_at, patch jsonb, fingerprint)`。
  - 函数签名里没有单独的分类、标签参数，但 `patch jsonb` 内部是否处理这些键，这次没有读函数正文。
- 迁移历史表无权限读取（permission denied）。仓库 `supabase/migrations` 共169个文件，最新一个是 `20261003140000_pos_optional_subcategory_completion.sql`。
- **没有验证的部分：**
  - 腾讯主库和腾讯路由（A1808）
  - 真机 1.1.104(126)
  - `handheld_item_update` 函数正文
  - 线上迁移历史

如果腾讯版已支持这5个字段，应以腾讯源码和 A1806 验证为准；本仓库与之不一致，不代表腾讯缺失。
