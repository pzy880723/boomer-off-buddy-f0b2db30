# 验证 HQ→分店线下 商品发布 + 库存同步

## 背景

代码层已完成：
- 分店链路探测（kdt_id / sell_channel_id / warehouse）已在 `/admin/api-integration` 打通
- `ensureBranchDistribution` 会走 HQ → `spu.update`（带 `sell_channel_setting_request`）→ 分店侧探测真实 `item_id`
- `pushYouzanQuantityUpdate` 强制 `hqSpuIdGuard`，只对已验证的分店 item_id 更新库存
- `channel-sync-worker` 已限制到线下渠道（`youzan_branch_offline`，channel=1）
- 所有出站都走 `youzanFetch` 代理

但**没有一次真实的端到端 code=200 证据**证明"总部商品 → 分店商品库 → 分店线下库存"这条完整链路已通。按 mem://constraints/youzan-must-use-proxy 铁律，未拿到真实 200 前不能对外声明"可以"。

## 目标

用测试 SKU「中信泰富点的 SPU（库存 1）」跑一次真实链路，逐段拿到 200 并记录返回体：

```text
[1] HQ spu.create/update  → 拿到 hq_spu_id
[2] spu.update 带 sell_channel_setting_request → 分店渠道分销成功
[3] 分店侧探测：youzan.retail.open.offline.spu.query（或 item.detail.get）
    → 拿到分店真实 offline_item_id / offline_sku_id
[4] pushYouzanQuantityUpdate(channel=1, kdt_id=分店) → 分店线下库存=1
[5] 复核：再次 query，确认库存和上架状态
```

任一段拿不到 200，就地停在那一步，把 code / message / trace_id / 原始响应贴出来，再决定改代码还是改配置。

## 落地步骤

1. 在 `/admin/api-integration` 里补齐 `retail.open.offline.spu.release` 和 `retail.open.offline.spu.query` 两个能力（如果 registry 里还没有），先用探测按钮拿到一次真实 200。
2. 用现有的 `/api/public/hooks/chain-probe-verify` 或新增一个只跑一次的 e2e hook，串起上面 5 步，返回每一步的完整响应快照。
3. 用中信泰富分店 + 测试 SPU 跑一次，把 5 步的 code=200 证据截屏/保存。
4. 全绿之后：
   - 把 `sku_channel_listings.verified_inventory_version` 和 `offline_item_id / offline_sku_id` 写回落库
   - 在 shop-mgmt/products 页面把"同步到有赞门店"按钮从灰色改成可用，并接到这条已验证链路
5. 任一步失败：把失败段的完整响应贴出来，判断是（a）代理/白名单问题、（b）有赞后台开关/权限问题（需要你在有赞后台操作）、还是（c）我们的代码问题，按对应路径修，不用版本 fallback 掩盖。

## 需要你确认的两点

1. **测试用 SKU**：是否就用之前那个"中信泰富点的 SPU（库存 1）"继续测？还是我建一个新的干净 SKU 避免污染历史数据？
2. **`offline.spu.release` / `offline.spu.query` 文档正文**：之前你只给了链接（有赞文档站是 SPA，我抓不到正文）。要么你把这两个接口的「请求参数表 + 响应示例 + 版本号」段落粘一下，要么允许我先用 registry 的探测按钮直接打真实接口（拿 200 就以响应为准，拿不到就据错误码判断）。选哪个？

（如果都同意，进入 build 模式后我按此计划执行，跑完贴出每一步的真实响应。）
