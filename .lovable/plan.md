# 商品印章与提示：只读审计 + 方案（待确认，尚未开发）

基于 canonical 当前提交 `ba70a42c`。本轮没有改代码、数据库或线上数据，也没有动三台相机的队列。

## 审计结论（已读代码证实）

**字典与约束**
- 唯一字典是 `src/lib/commerce/product-marks.ts`：特色印章 5 项（new/rare/limited/collectible/discontinued），提示标签 4 项（flawed/function_uncertain/function_unavailable/not_edible），其中功能不确定和功能不可用只能二选一。
- 数据库约束在 `drizzle/migrations/0095_product_featured_stamp_notice_tags.sql`：`inv_skus_featured_stamp_check`、`inv_notice_tags_valid()` / `inv_notice_tags_normalize()`，`handheld_item_update` 的允许字段名单里包含这两个字段。
- 现在**没有** `parts_missing`，代码和 SQL 里都搜不到。

**写入**
- ERP 端：`sku-edit-dialog.tsx` + `product-marks-fields.tsx`，经 `inventory.functions.ts` / `inventory.helpers.ts` 写入。
- 手持端：`items.$id.ts` → `handheld-item-edit.server.ts`（用 `item-edit-schemas.ts` 校验，做部分更新）。

**读取**
- 手持列表和详情（`handheld-products.server.ts`）会输出这两个字段的存储键，但 `category` 只返回编码，没有中文名或路径。
- 小程序列表和详情（`storefront-products.server.ts` 的 `buildStorefrontProduct`）通过 `readProductMarks` 输出这两个字段；`primary_category` 已经带中文 `name` 和 `path`（上级/本级）。
- ERP 商品列表**没有显示**印章和提示，只有编辑弹窗里能看到。
- 品牌缺失时字段为 `null`。服务端没有输出“未填写/待确认”这类文字，这些占位文字来自前端。

**推断（canonical 里看不到，需你们本地核对）**：iOS ProductsView 第 623 行只显示状态和成色，小程序 `utils/categories labelOf` 找不到中文时直接退回英文编码。这两处都不在本仓库。

## 方案

1. **新增“零件缺失”**：存储键 `parts_missing`，可与任意提示并选。需要一条增量迁移，更新约束函数 `inv_notice_tags_valid` / `normalize` 的允许名单，并同步更新 TS 字典。旧数据不受影响，取消勾选后数组里删掉这一项即可。
2. **ERP 商品列表**：在标题下的“销售中/成色”胶囊区，按字典顺序追加印章和全部提示的中文胶囊，没选就不显示。图片印章、瑕疵圈选、修图、打印都不动。
3. **手持 DTO**：新增可选字段 `category_name`、`category_path`（查 `inv_categories`，和小程序用同一种取法），保留 `category` 编码以兼容旧版本；另外加可选的 `mark_labels`，方便端上直接显示。
4. **小程序 DTO**：`primary_category` 保持不变；找不到分类时改为返回 `name: null`，不再输出“待归类”或编码，由前端隐藏这一行。品牌/IP 为空时保持 `null`，交给前端隐藏。
5. **测试**：`product-marks.test.ts` 加 parts_missing 的校验和顺序用例；`tests/sql/product_marks/cases.sql` 加约束接受/拒绝的用例；再加 DTO 用例，确认分类返回中文且不会退回编码。

## 迁移

需要一条迁移，只用于把 `parts_missing` 加进约束函数。其余几步都不需要迁移。

## 不做

不写真实商品、不重跑队列、不碰图片/抠图/打印，也不部署腾讯。iOS 和小程序的前端渲染由你们本地负责。
