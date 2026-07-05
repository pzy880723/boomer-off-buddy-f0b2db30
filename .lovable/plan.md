## 目标
让「仓库商品」和「门店商品」两个页面从第二次打开开始秒开，切换门店/搜索不再白屏；门店商品默认进入「标准商品」Tab。

## 现状问题
两个页面的 `useQuery` 都没有配 `staleTime`，React Query 默认 `staleTime=0`：每次进入路由都判定为 stale，重新请求 `listSkus` / `listShopSkus` / `listShopLinksForSkus` / `listYouzanShops` / `signSkuCovers`，期间整个列表被 loading 占位覆盖。切换门店、输入搜索时也是同样问题，旧数据被清掉，出现「加载中…」。门店商品的默认 Tab 又是 `custom`，而标准商品才是真正必然存在的一类，用户还得多点一次。

## 方案（只动前端表现层，不改后端）

### 1. 给列表查询加缓存 + 保留旧数据
文件：
- `src/routes/inventory.skus.index.tsx`（`inv-skus`）
- `src/routes/shop-mgmt.products.tsx`（`yz-branch-shops` / `shop-skus` / `shop-links`）

统一改法：
- `staleTime: 5 * 60 * 1000`（5 分钟内不再重取，切回页面直接用缓存渲染，无 loading）
- `gcTime: 30 * 60 * 1000`（30 分钟内不被回收）
- `placeholderData: keepPreviousData`（来自 `@tanstack/react-query`）——切换门店/输入搜索时，旧列表保留在屏幕上，右上角保留原有的小 spinner 提示，不再整屏白掉

`refresh()`（新建 SKU / 补货 / 重试上架后）继续用 `invalidateQueries` 主动作废缓存，保证操作后数据实时。

### 2. 门店商品默认进入「标准商品」Tab
`src/routes/shop-mgmt.products.tsx`：
- `useState<TabKind>("custom")` → `useState<TabKind>("standard")`
- `TabsList` 的顺序把「标准商品」放到最前（视觉上也符合默认选中）

### 3. 顺手优化 links 查询 key
`shop-links` 的 queryKey 现在拼了 `rows.map(r=>r.id).join(",")`，rows 每次刷新都会产出新数组导致 key 抖动。改成基于 `activeShopId + search` 的稳定 key（rows 变化时统一 invalidate），或用 `useMemo` 稳定 id 列表后再拼 key。这样也能享受到缓存。

## 交付顺序
1. 改两处路由文件的 `useQuery` 配置和默认 Tab
2. 打开预览手动验证：首次进入 → 有 loading；返回其他页再回来 → 无 loading 直接渲染；切换门店 → 旧列表保留 + 顶部小 spinner；新建/补货后列表刷新

## 不做
- 不改任何服务端函数、SQL、有赞同步逻辑
- 不动 `useSkuCovers`（已有 5 分钟 staleTime）
- 不引入路由 loader 预取（当前 Query 缓存已足够，避免和 SSR / 权限逻辑纠缠）
