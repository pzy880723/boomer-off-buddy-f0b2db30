# 生成「无法同步商品/订单」诊断报告

## 目标

整理一份可以直接发给有赞客服 / 技术支持的文档，让对方能复现并定位问题，无需我们再来回解释。

## 输出物

写入 `/mnt/documents/`，并在回复里用 `<presentation-artifact>` 暴露下载：

1. `youzan-sync-issue-report.md` —— 主报告（中文，结构化）
2. `youzan-sync-issue-report.pdf` —— 同内容 PDF，便于工单附件上传

## 报告内容大纲

1. **应用与店铺信息**
   - 自用型应用 `client_id`（脱敏，仅留前后 4 位）
   - 总部 kdt_id：`153242272`（BOOMER OFF vintage）
   - 分店 kdt_id：`187395218`（中信泰富店），`parent_kdt_id=153242272`
   - 授权方式：`grant_type=silent`（自用型，按 kdt_id 取 token）

2. **可以正常工作的部分**（证明授权链路本身是通的）
   - `POST https://open.youzanyun.com/auth/token` —— 两个 kdt_id 都能拿到 `access_token`
   - `youzan.shop.get / 3.0.0` —— 两家店都返回 200，`last_ping_ok = true`

3. **失败的接口（按调用顺序列出，每个接口给：方法名 + 版本 + 入参 + 实际返回 + 期望）**

   商品侧（依次尝试，没有一个成功，最终入库 0 条）：
   - `youzan.item.search / 3.0.0` —— 入参 `{page_no, page_size:50}`
   - `youzan.item.common.search / 1.0.0` —— 入参 `{page_no, page_size, kdt_ids:[…], item_type:61}`
   - `youzan.items.onsale.get / 3.0.0`
   - `youzan.items.inventory.get / 3.0.0` —— `banner:"for_shelved"`
   - 补详情用 `youzan.item.base.get / 1.0.0`

   订单侧：
   - `youzan.trades.sold.get / 4.0.0` —— 入参 `start_update/end_update` 和 `start_created/end_created` 各试一遍，区间 30 天，返回 `trades=[]`

   连锁子店列表（用于自动拉分店）也全部失败：
   - `youzan.retail.shop.list.query / 1.0.0`
   - `youzan.retail.shop.query / 1.0.0`
   - `youzan.shop.list.get / 1.0.0`

4. **典型错误码与原始返回片段**
   - 主要是 `[gw 4005] 非法的API`（来自 `gw_err_resp`）
   - 附最近一次日志里截取的 `trace_id`（如果有）和 `preview` 前 400 字（从 `youzan_sync_logs` 取最新非"自动重置"那一批）

5. **我们的判断与请求**
   - 4005 通常表示「该自用型应用没有勾选 / 没有开通该 API 的能力包」
   - 请求有赞确认：当前 `client_id` 对 kdt_id `153242272` 和 `187395218` 是否已开通
     - 商品类：`youzan.item.common.search`、`youzan.items.onsale.get`、`youzan.items.inventory.get`、`youzan.item.base.get`
     - 订单类：`youzan.trades.sold.get`（4.0.0）
     - 连锁类：`youzan.retail.shop.list.query` 或等价的子店枚举接口
   - 若没开通，请告知申请路径；若已开通仍 4005，请基于 `trace_id` 协助定位

6. **联系信息占位**（公司名 / 联系人 / 邮箱留空给用户自己填）

## 技术细节

- 用 Node + `pdfkit`（或 `md-to-pdf` / Pandoc 视环境而定）生成 PDF；优先 Pandoc，失败回退到 puppeteer-less 方案
- `client_id` 从 `process.env.YOUZAN_CLIENT_ID` 读取并脱敏（首 4 + ****  + 末 4）
- 失败接口列表 + 错误码直接从 `src/lib/youzan.functions.ts` 中已有的 `attempts` 数组和 `youzan_sync_logs` 表内容生成
- 报告语气：客观、可复现，不要写"你们 API 烂"，让对方愿意配合
