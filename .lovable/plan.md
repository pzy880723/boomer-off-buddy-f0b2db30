## 目标

让你在 ERP 内一站式完成有赞「消息订阅」配置，并能实时验证有赞是否成功把订单/退款事件推给我们。**不改动业务逻辑，只加可视化 + 引导**。

## 要做的事

### 1. 新增「消息推送」面板（`/youzan` 页面新增一个 Tab）
在现有的「门店」「系统检查」「API 体检」旁边加一个 **「实时同步」** Tab，内容：

- **一键复制推送 URL**：显示 `https://boomer-off-buddy.lovable.app/api/public/hooks/youzan-message`，右侧一个复制按钮。
- **必订阅事件清单**（表格）：`TRADE_TradePaid` / `TRADE_TradeSuccess` / `REFUND_RefundSuccess` / `REFUND_SellerAgree`，每行标注用途。
- **图文引导**（3 步折叠卡片）：
  1. 打开有赞云 → 应用中心 → 中古ERP系统 → 消息订阅
  2. 点「正式店铺推送网址」→ 修改 → 粘贴上面复制的 URL
  3. 打开右上角「消息推送服务」总开关 → 在下方勾选 4 个事件
- **右侧状态灯**：
  - 「最近一次收到有赞推送」时间（读 `youzan_sync_logs` 里 `action='message_push'` 的最新一条）
  - 30 分钟内 =🟢 已联通；无记录 =⚫ 尚未收到（提示"去有赞门店随便下一单测试"）

### 2. 消息日志展开区
面板下方一个可折叠列表，展示最近 20 条 `message_push` 日志：事件类型、kdt_id、时间、状态；点开看原始 JSON。方便调试。

### 3. 无需改的东西
- Webhook 端点 `/api/public/hooks/youzan-message` 已经写好、验签 + 落库 + 扣库存都齐了。
- `YOUZAN_CLIENT_ID` / `YOUZAN_CLIENT_SECRET` 已配置。

## 技术要点

- 新增 `src/components/youzan/message-push-panel.tsx` + 一个 serverFn `getMessagePushStats()` 读 `youzan_sync_logs` 汇总。
- 挂到 `src/routes/youzan.tsx` 已有的 Tabs 里，不动其他 Tab。
- 复制 URL 用 `navigator.clipboard` + toast 反馈。

## 你后续要做的（配好一次终身有效）

1. 打开 `/youzan → 实时同步` Tab，复制 URL。
2. 按面板 3 步引导在有赞云后台粘贴 + 勾选事件 + 开总开关。
3. 回到面板看「最近一次收到有赞推送」变成刚才的时间 = 完成。
