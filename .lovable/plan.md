## 目标（重写版）

APP 里 1:1 复刻 `/m/parcels` 手机网页版**全部功能**，作为首页「日本小包」磁贴入口。**只对 `super_admin` 可见**。改动只在 handheld 侧新增接口 + 补充 mem，不动 web 页面。

---

## 功能对齐清单（严格照抄 /m/parcels）

### 1. 列表页 `/parcels`
- 顶栏搜索框（`搜索商品名 / 子单号`），300ms 防抖，输入后关键词命中位置**高亮**（`highlight`）
- 顶栏右侧「拍照识图」入口（对应 `/m/photo-search`；见下方 Q1）
- **两个 Tab**：`待签收 / 已签收` — 服务端字段：
  - pending = `purchased / at_jp_warehouse / shipping_intl`
  - received = `delivered / completed`
- **两个维度切换**：`商品 / 包裹`（`ShoppingBag / Package` 图标），切换值本地持久化（对应 web `useParcelViewMode`；APP 端可用 SharedPreferences）
- **搜索时强制进入商品维度**（web 行为：`q.trim() ? "item" : storedMode`），维度切换按钮此时隐藏
- 无限滚动（下滑到底自动加载下一页）+ 底部状态文案（加载中 / 加载更多 / 没有更多）
- 异常包裹（`is_problem=true`）左侧红色竖条 + 右下 `AlertCircle` 图标
- **商品维度卡片**（items 模式）：
  - 64×64 首图（`toThumbUrl(200)`），无图 fallback `📦`
  - 品名 2 行 + `sub_order_no` + `signed_at`（若已签收）+ `system_code · 添加人 · 添加时间` 一行
  - 右侧：**avg CNY**（`item_total_cny / quantity`）+ `× N 件` + **拆包徽标**（红字：`拆 {pieces}{unit} · ¥{piece_cny}/{unit}`；条件：`pack_pieces > 1`）
- **包裹维度卡片**（parcel 模式）：
  - 64×64 首图 + 标题（`首件名 等 N 件`）+ `tracking_no / source_order_no` + `购 MM-DD` + 签收时间
  - 右侧：`grand_total_cny`（大字） + `avg_unit_cny × 件数`
  - 点击进入包裹详情页

### 2. 包裹详情 `/parcels/{id}`（对应 web `/m/receive/{id}`）
- 顶部包裹摘要卡片：首图 + 首件名等 N 件 + `tracking_no` 徽标（异常时红标）
- 详情 dl 列表：`状态 / 国际单号 / 来源订单号 / 卖家 / 商品合计 / 国际运费 / 关税 / 合计 / 重量 / 件数 / 购买时间 / 付款时间 / 签收时间 / 仓位 / 系统编码 / 添加时间 / 备注`（值为空的隐藏）
- 「子商品 N」列表：每项 40×40 图 + 品名 + `×qty · ¥{item_total_cny}` + ChevronRight → 点击弹出**商品详情底部抽屉**（同商品维度点击）
- 签收 / 异常 / 到货照片区块 → 见 Q1

### 3. 商品详情底部抽屉（`ItemDetailSheet`）
- 90dvh 可滚动，标题 = 中文名或原文
- 大图 + 详情卡：`sub_order_no / JPY 小计 (≈CNY 小计) / 单价 / 数量 / 重量 / 汇率 / 手续费 / 国内运费 / 运费补差 / 关税类目 / 税率 / 关税 / 运费分摊 / 关税(¥) / 到手价（红色加粗）/ 支付方式 / 支付时间 / 商户单号 / 平台 / 成色 / 附加服务 / 系统编码 / 添加人 / 添加时间 / 备注`
- **「拆包单价」卡片**（核心 write 功能）：
  - 已算过（`pack_pieces > 0`）→ 展示「整包拆 N 个 · ¥X/个」+ `重新计算` 按钮
  - 未算过 → 大按钮「拆包单价计算」
- 到货照片网格（4 列，最多 9 张，支持连拍多选 / 补拍） → 见 Q1

### 4. 拆包单价计算 Dialog（`PackPriceCalculatorDialog`）
1. 顶部商品概览 + 当前到手价（CNY）
2. **自动跑「标题分析」** → 命中就回填 pieces / unit（source=`title`）
3. 标题给不出且有图 → **自动跑「图片分析」**（送缩略图，1024px）→ 回填（source=`image`）
4. 手动输入 `pieces / unit`，UI 实时算 `¥{piece_cny}/{unit}`
5. 保存 → 写入 `japan_parcel_items.pack_pieces / pack_pieces_source / pack_unit_note`

---

## 一、ERP 侧交付（我实现）

### 端点清单（都在 `/api/public/handheld/parcels/*`，`X-Device-Token + X-Session-Token`，`super_admin` 独占；否则 403 `unauthorized_role`）

| 方法 | 路径 | 复用现有 server fn |
|---|---|---|
| GET | `/parcels/counts` | `{ pending, received }` 数字 |
| GET | `/parcels?bucket&mode=item\|parcel&q&limit&offset` | 抄 `searchParcels` 全部字段；item 模式包含 `landed_cny`、`pack_pieces` 等；parcel 模式包含 `grand_total_cny / avg_unit_cny / item_count / total_qty` |
| GET | `/parcels/{id}` | `getJapanParcel` 全字段 + items 全字段 + `totals`（items_cny / intl_total_cny / tariff_cny / grand_total_cny / weight / etc.） |
| POST | `/parcels/items/{item_id}/pack-pieces` | `updateParcelItem`：`{ pack_pieces, pack_pieces_source, pack_unit_note }`；`X-Client-Op-Id` 幂等 |
| POST | `/parcels/items/{item_id}/pack-pieces/estimate-title` | 转发 `estimatePiecesFromTitle`（服务端读 item 的 title / title_cn） |
| POST | `/parcels/items/{item_id}/pack-pieces/estimate-image` | 转发 `estimatePiecesFromImage`（服务端选缩略图 URL 送 AI） |

统一响应：`{ ok, code, ... }` 或 `{ ok:true, data }`；错误码遵循 `HANDHELD_ERROR_CODES`（含新加的 `unauthorized_role`、以及 `estimate` 命中的 `rate_limited / ai_credits_exhausted`）。

### 拆包成本响应结构（供 items 列表与详情）

- 每个 item 附带 `landed`：`{ item_jpy, freight_share_jpy, item_cny, freight_share_cny, tariff_cny, landed_cny, unit_price_cny, piece_price_jpy, piece_price_cny }`
- parcel 详情附带 `totals`：`{ items_jpy, items_cny, intl_total_jpy, intl_total_cny, tariff_jpy, tariff_cny, fx_rate, grand_total_cny, weight_g, quantity_total }`
- 全部服务端算好（复用 `computeParcelItemLanded + computePiecePrice + sumTariffJpy`），APP 直接展示，保证与 web 完全一致。

### schemas / openapi / errors
- `errors.ts` 已加 `unauthorized_role`
- `schemas.ts` 新增：`ParcelListQuery / ParcelListRes(item|parcel)/ ParcelDetailRes / ParcelCountsRes / ParcelPackPiecesReq / ParcelPackPiecesRes / ParcelEstimateTitleRes / ParcelEstimateImageRes`
- `openapi.ts` 新 tag `日本小包`，`sdk:check` 通过

### 权限 helper
`requireSuperAdmin(request)`（在 `parcels.ts` 内 re-export）：`authenticateDevice + resolveSessionUser + loadUserRoles`，`roles.includes("super_admin")` 才放行。

---

## 二、给 codex 的实现指引（回复末尾追加代码块）

### 磁贴
`authMe.roles.includes("super_admin")` 才渲染，图标 `Package`，标题「日本小包」，副标题「查看包裹与拆包单价」。点击进入 `/parcels`。

### 3 屏 + 1 弹窗
- **列表屏**：粘性顶栏（搜索 + Tab + 维度切换）+ 商品/包裹卡片（视觉见上方清单）+ 无限滚动
- **包裹详情屏**：摘要 + dl 详情 + 子商品列表 → 点击弹出「商品详情底部抽屉」
- **商品详情底部抽屉**：全字段展示 + 到手价加粗红字 + 「拆包单价」入口
- **拆包单价弹窗**：三步（标题 → 图片 → 手动）实时算 `¥/个`，保存回写

### 关键行为
- 搜索时强制商品维度，维度按钮隐藏
- 维度选择本地持久化
- 卡片右下拆包徽标：`pack_pieces > 1` 才显示，红字
- 关键词高亮抄 web `highlight`
- `toThumbUrl(size)`：列表 200、详情 600、AI 送图 1024
- 时间：MM-DD（列表） / MM-DD HH:mm（副行）/ 完整（详情）

### 测试脚本
```
1. 普通员工 → 首页无磁贴
2. super_admin → 磁贴出现，点入
3. 待签收/已签收 Tab 切换 + 徽标数字正确
4. 商品/包裹维度切换（默认商品；切了下次记住）
5. 搜关键词 → 强制商品维度 + 结果高亮
6. 商品维度：拆包徽标（pack_pieces>1）正确显示 ¥/个
7. 点商品 → 底部抽屉字段与 web 一致（到手价红色）
8. 抽屉「拆包单价计算」→ 自动跑标题；跑失败/无结果 → 自动跑图片；手输覆盖
9. 保存拆包 → 列表卡片徽标 & 抽屉数字同步更新
10. 包裹维度 → 点卡片进详情 → 子商品列表点击也弹同一个抽屉
```

---

## 需要你点头确认（1 个问题）

**「一键签收 / 异常 / 到货照片上传 / 拍照识图」这 4 个是否也要做进 APP？**
- 现在这个 plan 是「查询 + 拆包单价计算（含 AI）」全套，签收/异常/照片/拍照识图**没纳入**（这些都是写操作或独立场景）。
- 如果要一起做，我把 `POST /parcels/{id}/deliver`、`POST /parcels/{id}/problem`、`POST /parcels/items/{id}/photos`、`POST /parcels/photo-search` 也塞到同一个 plan 里，接口和 UI 都补齐。
- 如果不做，就照现在的 plan 收尾。
