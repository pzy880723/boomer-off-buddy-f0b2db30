## 问题

1. 当前页面文件叫 `src/routes/stores.youzan.tsx`，URL 是 `/stores/youzan`，被理解成「门店列表」的子页，但侧边栏里"有赞对接"是和"门店列表/加盟商管理"平级的独立入口，不应该挂在 stores 路径下。
2. 顶部还放了"← 返回仪表盘"按钮，主框架本来就有侧边栏导航，顶层页面不需要"返回"。
3. 截图里能看到左侧有"判 / 的 / + 单 / 信"这种文字穿透 —— 是因为页面外层没有用统一的 page 容器（缺 `container/px`），窄屏下卡片直接顶到了侧边栏边缘，视觉上像"坏掉了"。

## 方案

### 1. 路由迁移：`/stores/youzan` → `/youzan`

- 新建 `src/routes/youzan.tsx`，内容 = 把原 `stores.youzan.tsx` 整段搬过去，只改 `createFileRoute("/stores/youzan")` 为 `createFileRoute("/youzan")`。
- 原 `src/routes/stores.youzan.tsx` 改成 301 跳转兜底，避免老链接 404：

  ```ts
  export const Route = createFileRoute("/stores/youzan")({
    beforeLoad: () => { throw redirect({ to: "/youzan" }); },
  });
  ```

- `src/components/app-sidebar.tsx` 里把 `{ title: "有赞对接", url: "/stores/youzan" }` 改成 `url: "/youzan"`，并把类型联合 `"/stores/youzan"` 改为 `"/youzan"`。
- `src/routeTree.gen.ts` 不动 —— TanStack 插件会在 dev/build 时重新生成。

### 2. 去掉"返回仪表盘"按钮

`PageHeader` 的 `backTo` / `backLabel` 两个 prop 删掉。顶层导航入口不需要返回按钮。

### 3. 修页面外层容器 & 窄屏布局

- 在 `youzan.tsx` 最外层 `<div>` 加 `className="container mx-auto px-4 py-6 space-y-6"`（与 dashboard / inventory 等其他主页保持一致）。
- 4 个 MetricCard 的 grid 现在是 `sm:grid-cols-2 lg:grid-cols-4` ，946px 视口卡在 `sm` 档（两列）是正常的，但因为外层没 padding 才会贴边；加完 container 即可解决。
- "我的门店" 卡片网格保持 `md:grid-cols-2 xl:grid-cols-3`，加 `min-w-0` 防止内部 token / 错误信息撑爆。

### 4. 不动的部分

- 业务逻辑、server functions、汇总卡含义、"添加分店授权"弹窗交互、token 修复都保持原样。
- 仪表盘 / 其他页面对 `/stores/youzan` 的硬编码引用，搜索后只在侧边栏，已在第 1 步统一改掉。

## 验证

1. 点击侧边栏「有赞对接」→ URL 变为 `/youzan`，页面正常渲染，无返回按钮。
2. 浏览器里手动访问 `/stores/youzan` → 自动跳到 `/youzan`。
3. 把预览拉到 ~950px 宽，4 张汇总卡两列排列，门店卡两列，左右有 padding，不再有文字穿透/贴边的视觉故障。
