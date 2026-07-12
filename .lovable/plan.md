# HQ → 分店：商品库 + 网店 + 线下 库存端到端联通 & 沉淀到 API 联调

## 一、目标（用大白话）
挑一个总部已建好的孤品 SKU（库存=1），推到「中信泰富」分店，达成三件事：
1. **商品库出现**：分店后台的商品档案能搜到这个商品。
2. **网店可售**：分店网店渠道有货、可下单。
3. **线下可售**：分店线下门店渠道有货、可扫码/开单。

同时把这条链路上用到的每一步接口，都作为独立能力卡片写进 `/admin/api-integration`，一键可测、可看真实响应。

## 二、当前掌握的事实（避免重复踩坑）
- 总部授权、分店授权、代理出口 IP、分店组织树（sell_channel_id）、仓库查询——**已全部跑通**。
- 现有 `ensureBranchDistribution`（`src/lib/youzan-sync.functions.ts` L1782）已经做了：HQ SPU → `spu.update` 追加 `sell_channel_setting_request` → `item.detail.get` 反查真实分店 `item_id/sku_id` → 写 `sku_youzan_links`。
- 现有 `pushYouzanQuantityUpdate` 走 `item.quantity.update/4.0.0`（全量覆盖，type=0）。
- 但**当前只覆盖了「网店」这一个 sell_channel**；线下门店渠道号从未单独解析、也从未被塞进 `sell_channel_setting_request`。
- 所有有赞调用必须走 `youzanFetch`（已写进 mem://constraints/youzan-must-use-proxy），本轮新写代码一律遵守。

## 三、要新增/补齐的能力（写进 `integration_api_registry`）

| capability_key | 名字（人话） | method | ver | token | 用途 |
|---|---|---|---|---|---|
| `retail.open.sellchannel.list` | 查询分店的销售渠道（网店+线下） | `youzan.retail.open.sellchannel.list` | 3.0.0 → 1.0.0 fallback | 分店 token | 拿到该分店下**网店 sell_channel_id** 和**线下 sell_channel_id**（现在我们只用了一个，导致线下无货） |
| `retail.open.spu.distribution` | 一键铺货到分店（网店+线下都铺） | `youzan.retail.open.spu.update` | 3.0.0 | HQ token | `sell_channel_setting_request.is_partial=1`，`sell_channel_ids` **一次带 [网店, 线下]** |
| `item.detail.get.branch` | 反查分店真实 item_id / sku_id | `youzan.item.detail.get` | 1.0.1 → 1.0.0 | 分店 token | 拿到分店 item_id 才算真的铺进去了 |
| `item.quantity.update.online` | 同步库存到分店网店 | `youzan.item.quantity.update` | 4.0.0 | 分店 token | `type=0` 全量覆盖，`kdt_id=分店` |
| `item.quantity.update.offline` | 同步库存到分店线下 | `youzan.item.quantity.update` | 4.0.0 | 分店 token | 与上同 method，但带**线下 sell_channel_id / warehouse_code** 参数，验证线下也能改库存 |

顶部**再加一个「一键端到端铺货 + 双渠道库存」大按钮**，按顺序跑：
① 解析分店渠道 → ② HQ `spu.update` 一次带两个 channel → ③ 分店反查 item_id → ④ 网店 quantity.update → ⑤ 线下 quantity.update → ⑥ 在分店后台商品库 `online.spu.query` 再确认一次能搜到；每一步展示 code / message / trace_id / 原始响应，任一步失败立刻停并高亮那一步。

## 四、代码改动清单（都走 `youzanFetch`）

1. **`src/lib/youzan-sync.functions.ts`**
   - 新增 `resolveBranchSellChannels(branchToken, branchRow)`：调用 `sellchannel.list`，返回 `{ online_id, offline_id, raw }`（区分渠道类型字段以有赞返回为准，命中不到的字段保留 null 并把 raw 传回前端）。
   - 改 `ensureBranchDistribution`：`sell_channel_ids` 从 `[chan.sellChannelId]` 改为 `[online_id, offline_id].filter(Boolean)`；线下 id 存到 `youzan_shops.offline_sell_channel_id`（新列，见迁移）。
   - 新增 `pushYouzanQuantityUpdateOffline(sku_id, shop_id, qty)`：与 `pushYouzanQuantityUpdate` 同 helper，但把 `sell_channel_id`/`warehouse_code` 明确传给线下渠道。
2. **`src/lib/integration-capabilities.functions.ts`**
   - `DEFAULT_CAPABILITY_MAP` 加上表格里的 5 个 key。
   - `runProbe`：为每个 key 写独立 probe 分支，全部通过 `youzanFetch`。
   - 新增 `runBranchE2E(sku_id, shop_id)`：串起 5 步，返回每步 `{ step, ok, code, message, trace_id, preview }[]`。
3. **`src/routes/admin.api-integration.tsx`**
   - 顶部加「一键端到端铺货 + 双渠道库存」按钮，弹出选 SKU + 选分店，跑完展示 6 步时间线（成功打对勾+撒花，失败翻译成人话）。
   - 5 个新 capability 卡片：左侧一句话说明（"给分店的网店进货""给分店的线下门店进货"），右侧一键测试。
4. **数据库迁移**（一次 migration）：
   - `youzan_shops` 加 `offline_sell_channel_id bigint`、`online_sell_channel_id bigint`（沿用原 `sell_channel_id` 做兼容默认=网店）。
   - `integration_api_registry` 插 5 条 seed。

## 五、验收步骤（本轮由我在沙箱里跑，不让你手动点后台）
1. 迁移落库、seed 完成。
2. 挑现有测试 SKU（库存=1）+ 中信泰富分店，调 `runBranchE2E`。
3. 期望全绿；如某一步红，返回给你翻译后的原因（"是有赞侧还缺配置" vs "我这边代码要改"），不再让你去猜。
4. 在 API 联调页截图验证 5 个新卡片 + 端到端按钮出现。

## 六、不做的事
- 不动 `commit_sale / channel_sync_outbox` 等已跑通的孤品状态机。
- 不改 HQ 建品逻辑。
- 不再引入任何 fallback 逻辑掩盖失败——任一步真的失败就报出来。
