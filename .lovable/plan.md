## 目标

在手机端 `/m` 下加一个「快速录入小包订单」入口，覆盖闲鱼/抖音/小红书/微信/拼多多等渠道的零散下单场景。员工在手机上直接：拍照/相册选图/粘贴文字 → AI 解析 → 确认 → 入库。复用 PC 端现有的截图识别管线（`recognizeDomesticScreenshots`），无需新写 AI 逻辑。

---

## 一、入口

在 `/m`（手机首页）新增一个一级卡片「快速录入小包」，图标 + 副标题「截图/拍照/粘贴 → AI 识别入库」。点击进入 `/m/domestic/quick-add`。

底部导航（若有）也加一个 tab；没有就只放首页卡片。

## 二、`/m/domestic/quick-add` 页面流程

单页三段式，从上到下：

1. **平台选择（可选）**
   - 横向 chip：闲鱼 / 抖音 / 小红书 / 微信 / 拼多多 / 自动识别（默认）
   - 选了就作为 `hint_platform` 传给 AI，提升准确率
2. **图片区**
   - 大按钮「拍照」（调起 `<input type="file" accept="image/*" capture="environment">`）
   - 次按钮「从相册选」（`accept="image/*" multiple`）
   - 第三按钮「粘贴截图」（监听 `navigator.clipboard.read()`，iOS Safari 不支持时隐藏）
   - 缩略图网格，最多 15 张，可单张删除
   - 微信场景：还可以「粘贴聊天文字」展开一个 textarea（识别时把文字打包成一张文本图发给 AI，或直接走纯文本 prompt——见技术细节）
3. **识别按钮 + 结果卡片**
   - 「AI 识别」按钮，调用现有 `recognizeDomesticScreenshots`
   - 返回的 `orders[]` 每条渲染成可编辑卡片：平台、卖家、商品、数量、单价、运费、合计、下单时间、物流、状态
   - 每条卡片右上角有「忽略」按钮（不入库）
   - 底部「全部入库」按钮，循环调用现有 `createDomesticOrder`（或新增批量 `createDomesticOrders`）

## 三、复用 vs 新增

复用：
- `src/lib/domestic-recognize.functions.ts` 的 `recognizeDomesticScreenshots`（已支持 1~15 张图 + `hint_platform`）
- `src/lib/domestic-orders.functions.ts` 的创建 fn
- `MobileShell`、`PhotoUploaderGrid`（`src/components/mobile/photo-uploader-grid.tsx` 已有）

新增：
- `src/routes/m.domestic.quick-add.tsx` — 主页面
- `src/components/mobile/domestic-quick-add/`
  - `recognized-order-card.tsx` — 单条可编辑卡片（复用 PC 端 import 页的 UI 思路，缩成手机版）
- `src/routes/m.index.tsx` — 加一个入口卡片
- （可选）`src/lib/domestic-orders.functions.ts` 增加 `createDomesticOrdersBatch`，单事务批量插入，减少手机端网络往返

## 四、技术细节（非用户向）

- 图片压缩：上传前用 canvas 压到长边 ≤ 1600px、JPEG 0.8，避免手机大图把 base64 撑爆（`browser-image-compression` 或手写）
- 微信聊天文字模式：用一段附加 prompt 走 `generateText`（不走图片），需要在 `domestic-recognize.functions.ts` 加一个姐妹 fn `recognizeDomesticText(text, hint_platform?)`，返回同样的 `orders[]` 结构
- 状态管理：本地 React state 即可，不入 Query 缓存；入库成功后跳到 `/m`（或停留显示「已入库 N 条」）
- PWA：现有 `public/m-manifest.webmanifest` 已注册手机端 PWA，安装到桌面后可直接打开此页
- 不做：iOS 分享菜单（Share Target API iOS 不支持）、安卓快捷指令——下一轮再考虑

## 五、落地顺序

1. 加 `m.domestic.quick-add.tsx` 路由 + `m.index.tsx` 入口卡片，先打通「选图 → 识别 → 显示卡片」
2. 接入入库（先单条循环，够用就不做批量 fn）
3. 加微信文字粘贴模式 + `recognizeDomesticText`
4. 加图片压缩

---

请确认：
- 入口放 `/m` 首页一级卡片 OK 吗？还是想放底部 tab？
- 第一版要不要包含「微信聊天文字粘贴」模式？（不要的话只做截图识别，更快上线）
