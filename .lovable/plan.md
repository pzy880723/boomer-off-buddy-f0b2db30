## 目标

把**手机网页版**的日本小包功能（`/m/parcels`）搬到 codex 的 Android APP 里，作为首页一个磁贴。**只对 `super_admin` 可见**。核心用途：**查包裹 + 看拆包后的到岸成本**（只读，不做收货/改状态/补拍等写操作）。

---

## 一、ERP 侧交付（我这轮做）

### 1. 新增 3 个 handheld REST 端点，全部 `/api/public/handheld/parcels/*`，只读

| 方法 | 路径 | 作用 | 复用现有 server fn |
|---|---|---|---|
| GET | `/parcels?bucket=pending\|received&q=&limit=&cursor=` | 列表（游标分页，同 `/m/parcels`） | `searchParcels` |
| GET | `/parcels/counts` | 顶部 Tab 徽标数字 | `getMobileCounts` |
| GET | `/parcels/{id}` | 详情 + items + **已算好的拆包成本**（到岸单价 / 单件价 / 合计 CNY） | `getJapanParcel` + `getParcelLandedContext` |

**拆包成本响应字段**（这是本次的核心，详情接口必须返回）：
- `parcel_totals`: `items_jpy` / `intl_fee_cny` / `domestic_fee_cny` / `fx_rate` / `total_cny`
- `items[].landed`: `unit_price_cny`（到岸单价）/ `piece_price_cny`（组包时的单件价，走 `computePiecePrice`）/ `qty` / `subtotal_cny`
- 所有金额服务端算好，APP 直接展示，不再前端算，保证与 web 完全一致。

**鉴权**：抽 helper `requireSuperAdmin(request)` → 检查 `user_roles` 含 `super_admin`；否则 403 `code=unauthorized_role`。三个端点全走这个 helper。

### 2. schemas.ts / openapi.ts / errors.ts 同步更新

- 新增 zod：`ParcelListQuery` / `ParcelListRes` / `ParcelDetailRes` / `ParcelCountsRes`。
- OpenAPI 新 tag `parcels`，`bun run sdk:check` 通过。
- 新错误码 `unauthorized_role`。

### 3. `/auth/me` 已经返回 `roles: string[]`，codex 直接用它决定是否渲染磁贴，不用改。

---

## 二、给 codex 的实现指引（这轮结束后追加到「给 codex 的指令」代码块）

### 磁贴入口

- 首页多一个磁贴 `japan-parcel`，图标 `Package`，标题「日本小包」，副标题「查看包裹与拆包成本」。
- **可见性**：`authMe.roles.includes("super_admin") === true` 才渲染，否则整块隐藏。
- 点击进入内部路由 `/parcels`。

### 两个屏幕（1:1 对齐 web `/m/parcels` 视觉，只做只读）

**Screen A — 列表**（对齐 `src/routes/m.parcels.tsx`）
- 顶部 Tab：`待收货 / 已收货`，右边徽标来自 `/parcels/counts`。
- 粘性搜索框，300ms 防抖，输入后关键词高亮（同 web `highlight` 效果）。
- 卡片：88×88 首图 `toThumbUrl(80)` + 系统单号 + 状态 pill + 下单人 + 支付日期 `MM-DD` + items 数 + **合计 CNY**（直接用响应体 `parcel_totals.total_cny`）。
- 无限滚动，`cursor` 翻页。
- 空状态：`没有匹配的包裹`。

**Screen B — 详情**（对齐 web 详情但去掉所有写按钮）
- 顶栏：返回 + 系统单号，无三点菜单，无「整单收货 / 标问题」按钮。
- 状态条：5 段 pill `purchased → at_jp_warehouse → shipping_intl → delivered → completed`，当前段高亮，只展示不可点。
- **拆包成本卡片**（核心）：
  - 商品合计（JPY） / 国内运费（CNY） / 国际运费（CNY） / 汇率 / **合计 CNY**（加粗大字）
  - 一行说明：`拆包后单件成本已算好`。
- **items 列表**：图 + 品名 + 数量 + **到岸单价 CNY** + **单件价 CNY**（组包时才显示） + 小计 CNY。
  - 每个 item 卡片可点击展开，看原始 JPY 单价、抓取 URL、备注。
  - 右侧无「补拍」按钮。
- CNY / JPY 切换沿用现有 `CurrencyToggle` 观感（纯前端切换显示，数据两套都在响应里）。

### 复用与约束

- 图缩略图：已有的 `toThumbUrl(px)`。
- 状态枚举严格 5 档，颜色映射抄 web `simplifyStatus`（我会把常量贴在 openapi description）。
- 金额：CNY 保留 2 位小数前置 `¥`；JPY 整数前置 `¥` 并加 `(JPY)` 后缀区分。
- **写操作全部不做**：不实现收货、不实现标问题、不实现补拍照片、不实现编辑。以后要再加另开一轮。

### 测试脚本

```
1. 普通员工登录 → 首页看不到磁贴
2. super_admin 登录 → 磁贴出现，点入
3. pending / received Tab 切换 + 徽标数字正确
4. 关键词搜（单号后 4 位 / 品名） → 高亮 + 过滤
5. 打开 1 个 parcel → 拆包成本卡片的合计 CNY 与后台 web 详情完全一致
6. 组包型 item 显示「单件价」，非组包不显示
7. CNY / JPY 切换正常
8. 无任何写按钮
```

---

## 三、我本轮产出清单

1. `requireSuperAdmin` helper + 3 个新只读端点
2. `schemas.ts` / `openapi.ts` / `errors.ts` 更新，`sdk:check` 通过
3. `mem://features/handheld-parcels` 新记忆：只读接口清单 + super_admin 门槛 + 拆包成本响应结构
4. 回复末尾一个「给 codex 的指令 · YYYY-MM-DD · 第N条」代码块，含 baseURL、磁贴门槛、2 屏 UI 规格、测试脚本

---

## 需要你点头确认

1. **只读方向对不对？** 只查包裹 + 拆包成本，不做任何写操作（收货 / 标问题 / 补拍以后再说）。
2. **详情要不要保留状态条？** 我默认保留（不可点，纯展示）；不想要就删。
