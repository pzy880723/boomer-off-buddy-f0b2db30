# 图片补修与后台恢复验收

日期：2026-09-27。线上：`https://erp.boomeroff.com`。

## 已更新的商品

| 商品 | ERP SKU | 本次替换 | 价格 | 新天地库存 |
| --- | --- | --- | --- | --- |
| Hello Kitty 迷你冰箱 | 18ace324-fbd1-4c8e-8dcd-12f01329a99e | 第 1 张，其他 2 张不变 | 399 元 | 1 |
| KORG x Pochacco TM-60 | fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3 | 第 1、2 张 | 299 元 | 1 |

三张图片经过背景优化和视觉复核后，采用新对象路径替换，不覆盖原始照片。复核保留配件位置、主要印刷信息、磨损和贴纸破损；早期生成图改错食品包装与温控数字，已拒绝使用并重新修正。视觉检查不是像素不变保证。

最终 ERP 对象（均在 sku-listing bucket）：

- `2026-09-27/18ace324-fbd1-4c8e-8dcd-12f01329a99e/reviewed-f7592152-9558-4e57-bebe-fde30e9793fd.png`
- `2026-09-27/fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3/reviewed-90e3cdf0-28b6-4ec1-8446-60680eeafe44.png`
- `2026-09-27/fdb78dc9-0bfc-4ca7-a35f-87c4d8866ea3/reviewed-e2437ef0-1ee7-4303-abb8-b57d2d733462.png`

## 有赞回读验收

17:55:04 完成 65 项前后断言：

- 两件商品全部 5 张图，在有赞总部和新天地门店共 10 个有序图片位置，下载后均与 ERP 源图按现有上传压缩流程生成的像素一致。
- Kitty outbox revision 2、KORG revision 3 均 succeeded；分别同步 3/2 张，遗漏 0，无错误。
- Kitty 未替换的两张图，原对象路径、源文件字节、解码像素、尺寸均未变。
- 价格、条码、商品关联、上架状态、已售数量和全部库存字段未变。
- ERP、新天地渠道库存、WMS 库存均各 1；温州和中信泰富商品渠道 absent，WMS 库存 0。
- 未连接实体收银设备，没有将 API/像素核验宣称为终端缓存或屏幕验收。

原始证据保存在本机及腾讯服务器 `/tmp/faithful-three-reviewed-verification-20260927.json`（0600），SHA256：`d6a13a2e41028889964f474c59fa12d71477cdc4f449dcc9d7fe83c6cbc8eaae`。API 与图片下载证据路径在该报告内，不向日志输出凭证。

## 后台防复发修复

- 沿用前次上线的检测失败抛错与重试，不能把原图补边误报为 AI 修图成功。
- 老图库任务增加 5 分钟租约及 claim token，中断后可以重新领取。
- 完成事务先锁 SKU、再锁任务，校验当前 token 和真实墙钟租约，再替换图片；过期任务不能覆盖新结果。
- 图片替换、同步 outbox、任务完成及商品汇总状态在同一事务中提交，数据库错误回滚，避免半完成。
- 原图已被用户删除或替换时不再复活，也不能误报成功；保留人工重排顺序。
- 失败按 30 秒、5 分钟、30 分钟、2 小时退避，最多尝试 5 次，最终失败不会冒充成功。没有承诺外部 AI 或网络永不失败。

迁移 `20260927092334_handheld_listing_image_recovery.sql` 已通过连接的 Lovable 数据库接口执行并登记。三个新增函数仅 service_role 可执行，anon/authenticated 无执行权。

## 测试与发布

- 本地 TypeScript/检测/worker 回归 77/77；SQL PGlite 回归 19/19，包含锁等待期间租约过期的回归；TypeScript 检查通过。
- 腾讯候选重跑打包回归 61/61、禁网络 PGlite 19/19，完整生产构建通过。
- 部署脚本的环境变量回归 5/5，覆盖未配置 flag、继承 false/空值及旧版本回滚禁用 worker。
- 候选与生产公共路由、库位权限、内容接口、调拨只读及匿名 worker 拒绝校验通过；不以 HTTP 200 替代图片回读。
- 发布前停止旧图片 timer/inline worker，核验旧 hook 503、processing 任务 0、数据库 active apply 请求 0，避免旧任务绕过新租约保护。
- 上线后发现部署脚本传入空 flag 导致 worker 禁用；已修正脚本并增加回归，生产以显式 true 恢复并 PM2 save。17:55:20 实际 worker 返回 HTTP 200、processed 0、failed 0，三个相关 timer active。
- 腾讯发布目录：`/var/www/boomer-erp/releases/listing-image-recovery-20260927`。
- 回退目录：`/var/www/boomer-erp/releases/listing-image-detection-20260927`。回退旧代码时必须禁用其图片 worker，避免绕过租约围栏；不要删除新迁移或重置商品图。
- host-owned `workers.env` 未修改。首次候选准备缺少测试用 PGlite，使用独立 `/tmp/boomer-recovery-test-runtime/node_modules`，没有修改共享生产 node_modules；resume-prepare 重新完整测试和构建后发布。
