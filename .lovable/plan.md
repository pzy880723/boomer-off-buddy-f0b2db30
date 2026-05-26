## 问题
1. `MobileShell` 的 `<header>` 用 `sticky top-0`，在 PWA / 全屏浏览器里被手机顶部信号栏遮挡（没有 safe-area 内边距）。
2. `/m/skus` 商品页把"新建"放在 `MobileShell` 的 `rightSlot`，同样被信号栏遮挡，整个按钮看不见。

## 改动（2 个文件，纯前端）

### 1) `src/components/mobile/mobile-shell.tsx`
给最外层容器加 `pt-[env(safe-area-inset-top)]`，让顶栏自动让出刘海/信号栏高度：

- 把外层 `div` 的 className 从
  `flex min-h-[100dvh] flex-col bg-background text-foreground`
  改为
  `flex min-h-[100dvh] flex-col bg-background text-foreground pt-[env(safe-area-inset-top)]`

这样所有手机页（/m/*, /store/*）的顶栏都会自动下移，不只是商品页。

### 2) `src/routes/m.skus.index.tsx` — "新建"按钮搬到搜索框右侧
- `<MobileShell title="商品 SKU" back="/m" rightSlot={NewBtn}>` 去掉 `rightSlot={NewBtn}`
- 把搜索框 `<div className="relative">…</div>` 用一个 flex 行包起来，右侧放 `NewBtn`：

  ```tsx
  <div className="flex items-center gap-2">
    <div className="relative flex-1">
      <Search … />
      <Input … className="h-10 pl-9" />
    </div>
    {NewBtn}
  </div>
  ```

- `NewBtn` 的 `Button` 高度对齐搜索框：`size="sm" className="h-8 px-2"` 改为 `className="h-10 px-3 shrink-0"`，下拉菜单和三项保持不变。

## 不动
- `MobileShell` 的 `rightSlot` 机制保留（其他页面如果以后要放按钮仍可用，且已在安全区内）
- `/m/parcels` 顶部那个搜索框右侧的相机按钮、tab 切换都不动
- 数据、路由、`StandardSkuDialog` / `BundleSkuDialog` / `MNewCustomSkuSheet` 均不动
- 桌面端不受影响