# 只读核对结论：Android 对齐 iPhone 1.1.95(117) 契约

范围：本仓库 HEAD `b4447f3228ea6bd5b1fd5da729faa98cf6b109b3`。本仓库不含腾讯最新代码，以下结论只说明本仓库，不能推断腾讯生产缺失。未改代码、数据库或配置，未调用 AI。

## 1. items/rapid-listing（image_enqueue / image_redo / GET image_batch_id、image_parent_id）
- 搜索 `src/`、`supabase/`：没有 `rapid-listing` 路由，也没有 `image_enqueue`、`image_redo`、`image_batch_id`、`image_parent_id`。
- 只有自动生成的 `src/integrations/supabase/types.ts:12682-12769` 列出共用数据库里的 RPC：`erp_rapid_listing_cancel/check/claim/discard/enqueue/finish/intake/list/retry`。这说明数据库里有快速上架函数（可能由腾讯迁移创建），但本仓库没有调用它们的路由。
- 结论：幂等、库存/上架字段无副作用、GET 不启动生成，这几项在本仓库都无法核实，应以腾讯源码为准。

## 2. privacy/ai-consent 版本
- `src/server/ai-guard.ts:2` 只有 `AI_POLICY_VERSION = "2026-10-09-v1"`，由 `custom-print-cards.server.ts` 等使用。
- 搜索不到 `2026-11-01-v4`、`2026-11-08-v5`、`2026-11-11-v7`，也没有区分图片授权和 Kimi 文字授权的独立策略。
- 结论：本仓库没有实现 v4/v5/v7 授权体系，独立授权也无从核实。

## 建议
Android 对齐时以腾讯源码和 iOS 1.1.95 为唯一依据。本仓库不需要做任何改动。
