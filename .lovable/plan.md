# App Store 剩余两项只读核查结果（未改任何代码/数据/账号）

## 1) 受限审核账号 / 非生产环境
- 结论：不存在。user_roles 只有 4 条 super_admin，没有 store_staff / store_manager 等受限角色账号；任何现有账号交给 Apple 都是总部全权限。
- 无独立非生产环境：preview 与正式共用同一个 Lovable Cloud 实例；仓库没有 staging/review 配置。101.34.236.101 是缺自提表的恢复库，且是生产数据副本，不能当审核环境。
- 最少落地（不开发新系统）：
  1. 新建一个独立 Lovable Cloud 项目（或独立分支项目）作为审核后端，只跑现有迁移，不导入生产数据。
  2. 只在该环境里放演示门店/商品，建一个 store_staff 账号并只授权该门店（user_location_perms）。
  3. 不配置有赞 token/代理、不配置腾讯短信与支付密钥，让外部写入天然失败关闭。
  4. App 审核包指向该后端地址（需要 App 支持切换 API 基址，或单独构建审核包）。
- 阻塞：App 是否能按构建切换后端地址未核实；手机号 OTP 登录依赖腾讯短信，审核环境需改用固定测试验证码或密码登录，需业务决定。

## 2) 旧客户端与发布顺序
- 需要授权的手持 AI 入口（8 个）：ai.recognize-item / recognize-title / prepare-listing-image / generate-summary、content.generate-from-sku、items/:id/recommendation-card、pack-pieces estimate-image / estimate-title。smart-create 在未授权时不排队 AI，指纹不受影响；其余接口（登录、浏览、手动上架、收银、打印）不需要授权。
- 现状：handheld_ai_consents 0 条，所以新后端一上线所有设备的 AI 都会返回 403。已登记的活跃设备版本有 0.2.0×2、1.0、1.1.20、e2e，记录里没有 56/57 的版本号（设备表里 app_version 可能没更新）。
- 建议顺序（不默认同意）：
  1. 先把 57 发给员工 iPhone 和 Android，在授权页让每个员工本人点同意。
  2. 查 handheld_ai_consents 是否已覆盖实际在用账号。
  3. 再发布腾讯后端 guard。56 及旧 Android 届时只有 AI 返回 403，非 AI 业务不受影响；提示升级即可。
- 0047 已实际应用：handheld_product_content 的 5 参版本（uuid,uuid,uuid,uuid,jsonb）和 6 参版本（多一个 text）都在，权限只有 postgres 和 service_role。

## 问题
- 审核环境要单独起一个新后端加审核构建，还是先用 TestFlight 内部测试，推迟公开审核？
