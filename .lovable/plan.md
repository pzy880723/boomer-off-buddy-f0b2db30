## 背景

当前 sidebar "门店加盟" 分组里的三个子页面（门店列表 / 门店商品库 / 加盟商管理）都挂在 `/stores/*` 路径下。手机端使用的是 `/store/*`（单数），技术上不冲突，但 URL 看起来还是 `store` 开头，容易混淆。你希望：

1. 分组名 **门店加盟 → 门店管理**
2. PC 路径完全脱离 `store`/`stores`，换成清晰可辨的前缀
3. 这几个页面就是 PC 大屏后台的 UI（保持现有桌面卡片/表格风格，不动业务逻辑）

## 改动方案

### 1. 路径迁移（PC 端，全部脱离 `store`）

| 现在 | 改为 |
| --- | --- |
| `/stores/list`        | `/shop-mgmt/shops`        |
| `/stores/products`    | `/shop-mgmt/products`     |
| `/stores/franchisees` | `/shop-mgmt/franchisees`  |
| `/stores/youzan`      | 删除（早已 redirect 到 `/youzan`） |

新建文件：
- `src/routes/shop-mgmt.tsx` （父布局，仅 `<Outlet/>` + head）
- `src/routes/shop-mgmt.shops.tsx`
- `src/routes/shop-mgmt.products.tsx`
- `src/routes/shop-mgmt.franchisees.tsx`

旧的 `src/routes/stores.*.tsx` 全部改成 `beforeLoad` 重定向到新路径（保留一次跳转，避免老链接 404），下一轮可以彻底删。

### 2. Sidebar 改造（`src/components/app-sidebar.tsx`）

- 分组 label：`门店加盟` → `门店管理`
- `NavTo` 类型：移除 `/stores/list /stores/products /stores/franchisees`，新增 `/shop-mgmt/shops /shop-mgmt/products /shop-mgmt/franchisees`
- 菜单项指向新路径，`有赞对接` 保持 `/youzan` 不变
- 底部 footer "在线门店 12/14" 这种 mock 文案不动

### 3. 页面内容（保持 PC 大屏 UI，仅做最小修整）

三个页面现有写法已经是 `PageHeader + Card/Table` 桌面风格，本轮只做：
- 把页面 head 的 `· 门店加盟` 文案改成 `· 门店管理`
- 复制现有 JSX 到新文件，路由声明改为新路径
- `stores.products.tsx` 内 server fn 调用（`listShopProducts` / `syncYouzanItems` / `TransferDialog`）原样保留，不改业务

> 本轮不动 `src/routes/store.*`（手机端 `/store/*` 完全独立，是 PWA 入口）。

### 4. 引用排查

执行 `rg "/stores/(list|products|franchisees)" src` 把所有内部 `<Link to=...>`、`router.navigate({to:...})`、`redirect({to:...})` 一并改成新路径。预计涉及面很小（sidebar 是主要入口）。

## 不在本轮范围

- 不重写 UI 视觉（你说"PC 大屏使用的 UI"，现状已经是桌面卡片/表格布局；如需 redesign 再单独发起）
- 不改门店商品库 / 调拨 的业务逻辑
- 不动手机端 `/store/*` 和 `/m/*`
