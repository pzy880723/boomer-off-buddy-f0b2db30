## 1. 排查有赞同步问题（先定位，再修）

查 `youzan_sync_logs` 最新 30 条发现：
- 最近一次 items 同步从 `13:36` 一直是 `running` 没结束；之前多条都是 `上次同步进程中断或超时（自动重置）`。
- 5/23 之后只在今天有几次尝试，全部失败/卡死，没有一次 items / orders 真正完成。
- HQ items 历史上能跑通（5/23 入库 12 条），但分店 items 从未真正回数据。

定位方向：
- `syncAllShops` 在一次请求里串行调所有店铺的 items + orders，超过 Worker 单请求超时 → 进程被掐 → 下次跑触发"自动重置"。
- 分店走的是 `youzan.retail.open.online.spu.query`（用总部 token + 分店 kdt_id），需要确认有赞返回是不是权限错误而不是空数据（目前日志里 message 都被 `自动重置` 覆盖看不到）。

修复方案：
- **"一键同步全部"改为后台模式**：UI 立即触发 `/api/public/hooks/youzan-sync-worker`（新增的 server route），handler 按 shop+action 拆成小任务循环 fire-and-forget（每个 shop 单独一次 server fn 调用），前端用 `youzan_sync_logs` 轮询展示进度，避免单请求超时。
- **超时阈值收紧 + 真错误落库**：当前自动重置逻辑把"running 超过 N 分钟"覆盖成模糊错误，把 N 调小到 2 分钟，并在 `callYouzanApiVerbose` 失败时把 `lastPreview` + `trace_id` 写进 `error` 字段，便于排查分店是否权限不足。
- **手动单店同步按钮**：每张门店卡片上加"同步本店商品/订单"按钮，方便分别排查。

## 2. 合并"有赞对接"与"有赞同步中心"

现状：左侧导航有两个入口：
- `/youzan`：门店列表、业务汇总、一键同步、折叠的"高级 · 同步明细"。
- `/youzan/sync`：未绑定 SKU / 库存不一致 / 推送失败 / 推送队列。

合并方案：
- 保留单一入口 `/youzan`，重命名导航为 **"有赞门店"**。
- 页面顶部保留：门店卡片 + 业务汇总 + 一键同步。
- 下方改为常驻 Tab 区（**不再折叠**），含 4 个 tab：
  - 同步明细（原折叠区，默认展开）
  - 未绑定 SKU
  - 库存不一致
  - 推送队列
- `/youzan/sync` 路由保留但 `redirect` 到 `/youzan?tab=mismatch`，避免外链 404。
- 侧边栏只留一个"有赞门店"菜单项，删除"有赞同步中心"。

## 3. 商品同步：把分店商品也拉过来

当前 `syncShopItems` 已支持分店分支（`youzan.retail.open.online.spu.query`），但因第 1 节的超时问题没真正跑成功。本次工作：
- 修好同步链路后，确保分店写入 `youzan_items`（`kdt_id` + `item_id` 唯一）。
- 在"有赞门店"页面新增 Tab **"门店商品库"**：按 shop 分组展示 `youzan_items`，可筛选 HQ / 分店、上下架、库存。
- 单条商品支持"绑定本地 SKU"操作，复用现有 `BindYouzanDialog`（反向：从有赞侧发起绑定）。

## 4. 双向同步基础（本期只做"准备"，不做完整推送链路）

- `sku_youzan_links` 已是 1:1 映射结构，目前只支持 HQ。本次扩展 `BindYouzanDialog`：可选择"绑定到哪个店铺"，多店铺时一个本地 SKU 可绑多条 `yz_item_id`（每店一条），数据库唯一键改为 `(sku_id, kdt_id)`。
- 推送时按 `sku_youzan_links` 中的每条绑定逐店推库存（队列已支持，循环展开即可）。
- 反向同步（有赞 → 本地）先只做"对账提示"：拉取 `youzan_items.stock` 写回 `last_pull_stock`，差异在"库存不一致" tab 展示；真正双向写回（有赞改库存自动减本地）放在后续迭代，先打好绑定与对账基础。

---

### 技术细节

- 新增 server route：`src/routes/api/public/hooks/youzan-sync-worker.ts`（按 `?shop_id=...&action=items|orders` 触发单店任务，handler 内 `await syncShopItems(...)`）。
- `syncAllShops` 改为只负责写 `pending` 队列并 fire `fetch(workerUrl)`，不等待返回。
- 迁移：`ALTER TABLE sku_youzan_links DROP CONSTRAINT ... ; ADD UNIQUE (sku_id, kdt_id);`
- 新文件：`src/components/youzan/shop-items-tab.tsx`、`src/components/youzan/reverse-bind-dialog.tsx`。
- 修改：`src/routes/youzan.tsx`（合并 tab）、`src/routes/youzan.sync.tsx`（改为 redirect）、`src/components/app-sidebar.tsx`（删一项）。
- 修改：`src/lib/youzan.functions.ts`（错误落库 + 自动重置阈值、按店推送循环）。

### 不在本期范围
- 有赞→本地的实时库存回写（webhook 监听）。
- 分店间商品差异化（同 spu 不同店不同价/不同库存）的 UI 编辑。
- 旧 `/youzan/sync` 路由文件删除（保留 redirect 一个迭代后再清理）。
