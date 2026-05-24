把 `/m` 底部导航里的「分拣」Tab 替换为「商品」，指向手机端 SKU 模块 `/m/skus`。

## 改动

**`src/components/mobile/mobile-shell.tsx`** — `TabBar` 中 `base="/m"` 分支：
- 将 `{ to: "/m/sort", label: "分拣", icon: Boxes }` 改为 `{ to: "/m/skus", label: "商品", icon: Boxes }`
- 图标继续复用 `Boxes`（语义吻合），其余 Tab（首页 / 包裹 / 扫码 / 识图）保持不变。

## 不在范围
- 保留 `/m/sort` 路由文件本身，仅从底部 Tab 撤掉入口，避免老链接 404。
- `/store` 一侧的 Tab 栏不动。
- `/m/skus` 页面内容不动。
