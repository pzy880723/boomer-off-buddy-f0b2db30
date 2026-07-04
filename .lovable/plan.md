
## 现状与瓶颈

新建小包裹页面（`/purchase/japan-parcel/new`）里每张商品图走的是 `src/components/japan-parcel/item-image-uploader.tsx` → `uploadFile()`：

1. 选/拖/粘图 → `createImageBitmap` → OffscreenCanvas 编 webp（长边 1600、quality 0.82）
2. 直接 `supabase.storage.from('parcel-item-images').upload(...)` 上传到 Supabase（Storage 在海外机房）
3. 全流程串行，且要**等上传完成**后才把 URL 塞进表单，UI 上只能干等一个 loading 圈

主要慢的原因：

- **上传距离最贵**：手机截图/相册原图常常 2–5 MB，压完还剩 300–800 KB，从国内直连 Supabase Storage 一张 3–8 秒很正常，是耗时大头。
- **压缩阈值太宽松**：`SKIP_COMPRESS_BELOW = 200 KB` + `MAX_DIM = 1600` + `quality 0.82`，商品缩略图其实用不到 1600 边，白白多传字节。
- **UI 阻塞感强**：预览要等「压缩 + 上传」都结束才出图；用户不知道卡在哪一步，感觉「很慢」。
- **多张图串行**：一次导入 N 个子订单时，用户逐张点上传，没有并行也没有队列提示。

## 目标

在不改后端/桶策略的前提下，把「点击选图 → 看到预览 → 表单可继续填」的等待感压到 1 秒内，实际上传在后台跑完，出错再回滚。

## 改动方案（仅前端 & 展示层）

改动集中在 `src/components/japan-parcel/item-image-uploader.tsx` 以及可复用工具 `src/lib/image-upload.ts`。

### 1. 更激进的压缩参数

- `MAX_DIM`: 1600 → **1280**（列表缩略只用到 256，1280 已足够放大查看）
- `QUALITY`: 0.82 → **0.78**（webp 感官几乎无差别）
- `SKIP_COMPRESS_BELOW`: 200 KB → **80 KB**（超过就走压缩，避免 300 KB 的截图原样上传）
- 预期同一张 3 MB 手机图从 ~700 KB 降到 ~250–350 KB，上传时间 ≈ 1/2。

### 2. 乐观预览 + 后台上传

- 选图后立刻用 `URL.createObjectURL(compressedBlob)` 生成本地预览塞进 `onChange`（同时把 blob 挂在组件 state 里）。表单立刻看到图、可以继续填其他字段。
- 真正的 `storage.upload` 在后台跑；成功后把 `objectURL` 替换成 Supabase 公网 URL，`revokeObjectURL` 释放内存。
- 失败：`toast.error`，把预览撤回 `null`，让用户重试。
- 保存表单时若某张图还在上传，禁用「保存」按钮 + 显示「N 张图上传中…」；避免把本地 blob URL 写进 DB。

### 3. 上传进度 & 并行

- 复用 `supabase.storage.upload`，但在覆盖层里换掉「转圈」为一个细进度条（Supabase JS v2 支持 `onUploadProgress` via fetch；没有就至少显示 0→90% 假进度 + 完成置 100%，视觉不再"卡住"）。
- 多张图同时选/粘时（未来批量），允许最多 3 个并行 upload，用一个简单的 semaphore，串行时间大概减半。当前只处理单图入口，semaphore 先落在 `image-upload.ts` 里，为后续批量做准备。

### 4. 首次交互零阻塞

- 组件已经用 `React.lazy` 引入，保留。
- 在真正拿到 `createImageBitmap` 之前，先立刻在 UI 上显示"压缩中..."骨架图（避免用户以为点击没反应）。

### 5. 观测

- 在压缩与上传前后 `performance.now()` 打点，`console.debug("[img] compress=%dms upload=%dms size=%dKB→%dKB", ...)`，方便后续回放确认是网络问题还是压缩问题。
- 不加任何埋点上报。

## 不改的东西

- Supabase 桶、RLS、路径规则不动。
- 服务端 / 后端逻辑不动，纯前端优化。
- `image-upload.ts` 里其他调用点（`/m`、`/store`）保持行为兼容——只把新的默认参数下沉，签名不变。

## 预期效果

- **感官延迟**：点图后 <500 ms 出预览、表单立刻可用；「上传中」变后台任务，不再是模态阻塞。
- **实际上传耗时**：单图从当前 ~5s 降到 ~2s 左右（取决于网络，压缩体积减半 + 并行）。
- **失败可回滚**：网络掉线只掉那张图，不影响正在填写的表单。

## 需要你确认的 1 件事

保存表单时，如果某张图还在后台上传，我的默认策略是「禁用保存按钮 + 顶部提示"还有 N 张图上传中"」。你也可以选：

- (A) 等所有上传完再允许点保存（当前默认，最安全）
- (B) 直接允许保存，未完成的图先不写入，后台上传成功后再补一次 `update`（体验最顺，但会多一次写库）

若不特别说，我按 (A) 实现。
