## 目标

在 `/purchase/japan-parcel/new` 表单页，当用户有未保存内容时离开页面（点「返回」、点侧边栏跳转、浏览器后退、刷新、关闭标签），弹出确认弹窗：「有未保存的修改，确定放弃吗？」。确认后才离开，取消则停在原页。

## 改动范围

仅改一个文件：`src/routes/purchase.japan-parcel.new.tsx`。纯前端 UI/交互，不动 server function、不动数据库。

## 具体方案

### 1. 判断「脏」状态（dirty）

新增 `const isDirty = useMemo(...)`：把当前 `parcel / intl / items` 序列化后跟初始空白基线对比。

- 基线：`JSON.stringify({ parcel: emptyParcel(), intl: emptyIntl(), items: [emptyItem()] })`，因为 `emptyItem()` 里的 `_key` 是随机 UUID，比较前先把 items 的 `_key` 字段剥掉。
- 脏的定义：序列化后的当前内容 ≠ 空白基线，且当前不在 `saveMut.isPending` 中。
- 保存成功后会调用 `setParcel(emptyParcel())` 等重置，`isDirty` 自动回到 `false`，无需额外标记。

### 2. SPA 内部跳转拦截（TanStack Router）

使用 `useBlocker` from `@tanstack/react-router`：

```ts
useBlocker({
  shouldBlockFn: () => isDirty && !saveMut.isPending,
  withResolver: true, // 返回 { status, proceed, reset }
});
```

- 拿到 blocker 后，在 `status === 'blocked'` 时弹一个 `AlertDialog`（已在 `components/ui/alert-dialog.tsx`）。
- 「放弃更改」→ 调用 `proceed()`；「继续编辑」→ 调用 `reset()`。
- 这会覆盖 PageHeader 里的「返回」`Link`、侧边栏导航、浏览器前进/后退等所有路由跳转。

### 3. 浏览器级离开拦截（刷新/关掉标签/跨域跳转）

用 `useEffect` 注册 `beforeunload`：

```ts
useEffect(() => {
  if (!isDirty) return;
  const handler = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };
  window.addEventListener("beforeunload", handler);
  return () => window.removeEventListener("beforeunload", handler);
}, [isDirty]);
```

浏览器会弹出系统级原生确认框（文案由浏览器决定，无法自定义）。

### 4. 两个「保存并继续添加」/「保存」按钮

保存流程本身会先把 state 写回空白，再 toast 或 nav，所以 `saveMut.isPending` 期间 blocker 已经被关闭，不会误拦截 `nav({ to: "/purchase/japan-parcel" })`。无需额外处理。

### 5. 弹窗 UI

复用现有 `AlertDialog`：

- 标题：`放弃当前修改？`
- 描述：`你在这一单里录入的内容还没有保存，离开后将会丢失。`
- 取消按钮：`继续编辑`
- 确认按钮：`放弃并离开`（`destructive` 样式）

## 不做的事

- 不持久化草稿到 localStorage（用户没要求，避免引入新机制和清理逻辑）。
- 不改保存按钮、不调整识别面板、不改列表/详情页。
- 不引入新的依赖。
