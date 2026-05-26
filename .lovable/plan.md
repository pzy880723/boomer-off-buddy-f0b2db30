## 目标
在手机端"日本小包列表"(`/m/parcels`) 的顶部搜索区,加一个相机按钮,点击直达已有的 `/m/photo-search` 拍照识图页(沿用现有 `photoSearch` serverFn,候选范围保持现状:最近 200 件带图日本小包子订单)。

## 改动范围
仅前端 1 个文件,无数据库 / 服务端改动。

### `src/routes/m.parcels.tsx`
- 在顶部搜索框右侧(或紧邻的工具栏位置)加一个图标按钮:
  - 图标 `Camera`(lucide-react,与 `/m/index` 卡片、底部 tab 保持一致)
  - 尺寸与现有搜索框同高,`aria-label="拍照识图"`
  - `<Link to="/m/photo-search">` 直接跳转,不带 query
- 与现有"包裹/商品"视图切换、高亮搜索逻辑互不影响

## 不做
- 不动 `photoSearch` 服务端逻辑、候选范围、AI 模型
- 不动 `/m/photo-search` 页面内容
- 不加桌面端入口、不扩展到 SKU 库存
