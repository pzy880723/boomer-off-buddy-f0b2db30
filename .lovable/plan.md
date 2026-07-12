
# 有赞总部→分店线下门店发布 · 按 Codex 方案落地

严格照 Codex 审计文档 (2026-07-12) 执行，只做增量修补，不重写代理 / 组织查询 / 总部建品 / outbox / commit_sale / 退款复检。

## 一、数据模型迁移（一支迁移）

1. `sku_channel_listings` 里现有 `youzan_offline` 记录全部改名为 `youzan_branch_offline`（更新 CHECK 约束 + 唯一索引），CHECK 中移除 `youzan_branch_online`，永不创建。
2. `sku_channel_listings` 新增 `verified_inventory_version int`。
3. `youzan_shops` 新增 `offline_sell_channel_id bigint`（明确保存线下门店那一条渠道；旧 `sell_channel_ids bigint[]` 保留做诊断）。
4. `channel_sync_outbox` 保证唯一键 `(sku_id, listing_id, action, inventory_version)`；已有则跳过。

## 二、注册表 (`src/lib/youzan-api-registry.ts`)

保留并明确登记：
- `youzan.retail.open.offline.spu.release`（发布到线下门店，分店 token）
- `youzan.retail.open.offline.spu.query`（按 spu_code/sku_code 回查，分店 token）
- `youzan.item.quantity.update` 4.0.0（线下渠道全量覆盖，分店 token）
- 线下上下架 / 库存回查接口（用官方文档版本）
- `youzan.retail.open.sellchannel.list` 只用来识别渠道类型

降为「诊断禁用」不进主链路：`spu.stores.distribute`、`spu.publish.to.stores`、`product.dispatch`，以及所有 `online.*` 接口。

## 三、`omnichannel-publish.functions.ts`

- 保留 HQ 幂等建品。
- 把 `releaseSkuToBranchCore` 改名 / 改造为 `publishSkuOfflineCore`：
  1. HQ 建品 / 回查 hq_spu_id/hq_sku_id（保留原有）。
  2. （可选）按官方要求先配置销售范围，但只作为前置，不当成 release 成功。
  3. 调 `offline.spu.release`。
  4. 调 `offline.spu.query` 用 `spu_code/sku_code` 回查，取真实 `offline_item_id/offline_sku_id`。
  5. 拿到真实 ID 才写 `youzan_branch_offline` listing，`external_item_id != hq_spu_id` 强制校验，禁用 `allowSameAsHqSpu`。
- 删掉一切 `online.spu.query` 证明线下成功的路径。

## 四、Worker (`channel-sync-worker.ts`)

- 只处理 `channel = youzan_branch_offline` 的任务。
- `publish_offline` 真正执行 release + query，不再只 verify。
- 支持 action：`set_stock` / `set_stock_zero` / `shelf` / `delist` / `verify_stock` / `verify_listing`。
- 每个动作执行前比较 `task.inventory_version` 与 `inv_skus.inventory_version`；旧任务直接置 `superseded`，不写有赞。
- 库存写入统一走分店 token + `offline_item_id/offline_sku_id` + `channel` 线下参数 + 全量覆盖，写完必须 `verify_stock` 回查。
- 删除 `allowSameAsHqSpu: true`。
- apikey 缺失或不匹配 `SUPABASE_PUBLISHABLE_KEY` 一律 401。

## 五、`test-publish-with-stock.ts`

- 复用为单件孤品灰度入口。
- 改用 `channel_sync_outbox`（不再写 `youzan_stock_sync_queue`）。
- 完整跑：HQ 建品/回查 → 线下 release/query → set_stock → verify_stock → shelf → verify_listing。
- 返回 HQ + branch offline 两条 listing 各自的 `external_*_id`、每步 `trace_id`、`inventory_version`，禁止输出 token / 代理 Bearer。

## 六、`reconcileAllForCron` 修正

`handleReconcile` 改为真实读取有赞线下库存与上下架状态，与 ERP 期望值比对，只有不一致才 enqueue 修正任务；一致直接更新 `verified_inventory_version`。

## 七、其他清理

- `ensureBranchDistribution`：`spu.update` 只传「线下门店」渠道 ID（来自 `offline_sell_channel_id`），不再把整个 `sell_channel_ids` 数组灌进去。
- 组织树探测在保存 `sell_channel_ids` 的同时，按渠道类型识别线下并写入 `offline_sell_channel_id`。
- 全项目搜索是否还有直连 `open.youzanyun.com` 的 `fetch` 调用；有就替换为 `youzanFetch`。

## 八、验收

在 `/admin/api-integration` 用「一件孤品灰度」按钮跑通 §11 全部勾选项，尤其：
- HQ 只有一条 SPU；
- 分店线下商品库能按条码查到；
- 分店线下可售库存 = ERP `stock_qty`；
- 并发售出不会负库存，退款不自动恢复。

## 技术细节

- 迁移文件命名 `2026-07-12_youzan_branch_offline.sql`，包含 rename + 新列 + CHECK 更新 + 索引重建 + GRANT 保留。
- 所有 API 版本 / 字段以现行有赞文档为准，注册表里每条都写 `docs_url`；未确认版本时优先取官方最新，不做多版本 fallback（除非官方文档明确列出）。
- 所有网关调用一律走 `youzanFetch`。
- 完成后追加「【给 Codex 的指令 · 2026-07-12 · 第N条】」代码块，报同步接口版本、字段和联调证据格式。

范围之外：不改代理、组织查询实现、总部建品幂等逻辑、`commit_sale`、退款复检 UI。
