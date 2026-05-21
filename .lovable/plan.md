
# 有赞对接：重新设计 + 数据汇总

## 目标

把现在那个"开发者调试台"风格的页面，改成业务人员一眼能懂的「门店面板 + 总部汇总」。技术细节（kdt_id / token / sync_log）全部藏起来，授权流程从"手填 kdt_id"改成"一键从总部拉取分店列表"。

## 一、页面信息结构（先看图）

```text
┌─ 顶部 ──────────────────────────────────────────┐
│ ← 返回           有赞门店                       │
│ 5 家门店在线 · 最近同步 2 分钟前      [立即同步] │
└─────────────────────────────────────────────────┘

┌─ 总部业务汇总（核心 4 项卡片 · 全部门店相加） ──┐
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │
│ │总营业额│ │总订单数│ │总商品数│ │总库存量│   │
│ │ ¥xxx万 │ │ x,xxx  │ │  xxx   │ │ xx,xxx │   │
│ │ 本月   │ │ 本月   │ │ 在售   │ │ 件     │   │
│ └────────┘ └────────┘ └────────┘ └────────┘   │
└─────────────────────────────────────────────────┘

┌─ 我的门店 ──────────────────[+ 添加分店授权] ──┐
│  🏠 总部 · BOOMER OFF                           │
│     ✓ 已连接  · 商品库 1,234 件                 │
│                                                 │
│  🏬 上海安福路店                                │
│     ✓ 已连接  · 本月 ¥xx,xxx · 32 单 [详情▸]  │
│  🏬 北京三里屯店                                │
│     ✓ 已连接  · 本月 ¥xx,xxx · 18 单 [详情▸]  │
│  🏬 成都太古里店                                │
│     ⚠ 授权即将过期（还剩 12 天） [立即续期]   │
└─────────────────────────────────────────────────┘

▾ 高级 / 同步明细（默认折叠，给我自己排查问题用）
```

页面顶部有 **← 返回** 按钮（回到 /dashboard），并且接入 AppSidebar 同样的面包屑/PageHeader，左侧栏导航本来就在「门店加盟 → 有赞对接」。

## 二、授权流程（自用型应用 · 不用 OAuth 跳转）

你们是自用型应用，有赞云不会给我们 OAuth 跳转链接。但我们可以做到**接近一键**的体验：

1. **总部一次性配好**：你在有赞云后台「自用型应用 → 测试店铺/授权信息」把总部 kdt_id 勾上授权（这步只做一次，已完成）。
2. **「添加分店授权」按钮 = 一键拉取**：点击后，后端用总部 token 调有赞**连锁门店 API**（`youzan.retail.shop.query` 系列）枚举出该总部下所有子店铺，弹窗里以**复选框**形式展示「门店名 / 地址 / 类型」，员工只需勾选要接入的店并点确认，就批量入库（自动调 `grant_type=silent` 拿每家的 token），全程不需要看到 kdt_id。
3. **降级方案**：如果连锁 API 在自用型权限下不可用，弹窗顶部给一段一图流引导（截图 + 一句话："去有赞云后台勾选门店授权，回来点刷新即可"），刷新后再次走第 2 步——同样不暴露 kdt_id 输入框。

未来如果要做"加盟商自己点链接授权"，需要把应用升级成"公开型/工具型"，那是另一个迭代，本次不做。

## 三、总部业务汇总（核心 4 项）

每张卡背后是一个 serverFn，聚合所有 `youzan_shops` 的数据：

| 指标 | 数据源 API | 入库表（新建） | 刷新策略 |
|---|---|---|---|
| 总营业额（本月 / 今日切换） | `youzan.trades.sold.get.4.0.0` | `youzan_orders` | 同步任务每 30 分钟跑一次 |
| 总订单数 | 同上 | `youzan_orders` | 同上 |
| 总商品数（在售 SKU） | `youzan.items.onsale.get.3.0.0` | `youzan_items` | 每天 1 次 + 手动刷新 |
| 总库存量 | `youzan.retail.stock.query` 或 `youzan.item.sku.get` 汇总 | `youzan_items`（含 stock_qty 列） | 同商品同步一起跑 |

**实现路径**：
- `src/lib/youzan-sync.functions.ts`：新增 `syncOrders(shopId)`、`syncItems(shopId)`、`syncAll()`。
- 新建 1 个公开 cron 路由 `src/routes/api/public/hooks/youzan-sync.ts`，每 30 分钟由 pg_cron 触发跑 `syncAll`。
- `src/lib/youzan-stats.functions.ts`：4 个聚合 serverFn 给页面卡片用，直接读本地 `youzan_orders` / `youzan_items`，不再实时调有赞（快、且不会触发限流）。
- 卡片可点：点「总营业额」跳到分店明细对比表，点「总订单数」跳订单流水。

## 四、和现有仪表盘的合并

把这 4 张卡也加到 `/dashboard` 顶部，作为「线下零售」分组，和现有的「采购 4 渠道」并列。这样仪表盘一眼能看出**采购成本 vs 线下营收**的全貌。

## 五、技术细节（给我自己看的，可跳过）

### 5.1 数据库变更（新增 2 张表）

```sql
-- 订单流水（按 shop + tid 唯一）
create table youzan_orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references youzan_shops(id) on delete cascade,
  kdt_id bigint not null,
  tid text not null,                    -- 有赞订单号
  status text,                          -- WAIT_BUYER_PAY / WAIT_SELLER_SEND_GOODS / ...
  pay_type int,
  buyer_nick text,
  total_fee numeric,                    -- 订单金额（分→元已折算）
  payment numeric,                      -- 实付
  num int,                              -- 商品件数
  pay_time timestamptz,
  created_time timestamptz,
  raw jsonb,
  inserted_at timestamptz default now(),
  unique (kdt_id, tid)
);
create index on youzan_orders (shop_id, pay_time desc);

-- 商品 + 库存（按 shop + item_id 唯一）
create table youzan_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references youzan_shops(id) on delete cascade,
  kdt_id bigint not null,
  item_id bigint not null,
  title text,
  price numeric,
  stock_qty int default 0,
  is_listed boolean default true,
  pic_url text,
  raw jsonb,
  updated_at timestamptz default now(),
  unique (kdt_id, item_id)
);
```

RLS 沿用现有的 open-policy 模式（项目其它表都是这样）。

### 5.2 文件改动

| 文件 | 动作 |
|---|---|
| `src/routes/stores.youzan.tsx` | 整体重写为「汇总卡 + 门店卡片网格 + 一键拉取弹窗」，删掉同步日志 DataTable 和 kdt_id 输入框 |
| `src/components/page-header.tsx` | 复用，加 `← 返回` |
| `src/lib/youzan.functions.ts` | 新增 `listAuthorizedShopsFromHQ`（调连锁 API）+ `batchImportShops` |
| `src/lib/youzan-sync.functions.ts` | **新文件**：`syncOrders` / `syncItems` / `syncAll` |
| `src/lib/youzan-stats.functions.ts` | **新文件**：4 个聚合查询 |
| `src/routes/api/public/hooks/youzan-sync.ts` | **新文件**：cron 入口，验 `x-cron-secret` |
| `src/routes/dashboard.tsx` | 顶部加「线下零售」4 张卡 |
| 旧的 `youzan_sync_logs` | 保留，但只在折叠「高级」区显示 |

### 5.3 cron 部署

迁移完成、cron 路由部署后，我用 `supabase--insert` 写一条 `cron.schedule` 调 `https://project--2158bffa-7f82-4bc6-9df9-c59319d262f7.lovable.app/api/public/hooks/youzan-sync`，每 30 分钟一次。

## 六、分期交付

**Phase A（本轮）**：
- 重设计页面 UI + 返回按钮 + 一键拉取分店弹窗（先用连锁 API，失败则降级到引导）
- 4 张汇总卡（仅做静态/0 值兜底，没数据先显示「等待首次同步」）
- 数据库迁移：`youzan_orders` + `youzan_items`

**Phase B（确认 A 后）**：
- 实现 `syncOrders` / `syncItems` 并打通 cron
- 4 张卡接真实数据
- 汇总卡同步搬到 `/dashboard`

---

确认这个方向就开始 Phase A。如果你希望分店卡片上还要看到别的指标（比如"本月退款数"、"在线/离线状态"等），现在告诉我加进去。
