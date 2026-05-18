## 问题定位

用户点击"登录后台"按钮后：
- 没有任何网络请求发往后台（确认无 `/token` 调用）
- 页面 URL 变成 `/login?`，是浏览器**原生表单 GET 提交**导致的刷新
- 手机号 / 密码被清空，是页面重新加载的副作用

根本原因：浏览器装的 **沉浸式翻译** 和 **market-mate-for-1688** 扩展在 SSR HTML 上注入了 DOM（`<input id="tm1ine29geg">`、`data-immersive-translate-page-theme` 等），导致 React 水合失败。水合失败的那一刻，`<form onSubmit>` 还没绑定，点击按钮就退回到浏览器默认的表单提交行为。

后台账号本身已经修好了，无需再动数据库。

## 修复方案（只改前端）

### 1. 让登录页只在客户端渲染，绕开水合问题

`src/routes/login.tsx` 中用 `useEffect` 把 `mounted` 设为 true，未挂载前只渲染一个静态骨架（不带表单事件），挂载后再渲染真正的表单。这样表单一定是客户端创建的，不会有水合失败的问题。

### 2. 双保险：按钮也手动拦截

把"登录后台"按钮改成 `type="button"`，把提交逻辑挂在 `onClick` 上同时保留 `<form onSubmit>`，确保即使浏览器扩展继续捣乱，按钮点击也走我们的 JS 而不是原生提交。

### 3. 在根 `<body>` 加 `suppressHydrationWarning`

`src/routes/__root.tsx` 的 `<body>` 标签加 `suppressHydrationWarning`，减少其它页面被翻译扩展污染时出现的水合警告。

## 用户侧建议（非必须）

修复后即可正常登录。如果之后还想彻底避免扩展干扰，可以在登录这一页临时关闭"沉浸式翻译"和"market-mate"插件，但代码层面这次修完就不会再被它们影响了。
