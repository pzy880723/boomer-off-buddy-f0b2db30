# BOOMER 腾讯统一数据平台迁移手册

## 当前状态

- Lovable ERP 仍是 ERP 生产主库，未切换、未停写。
- BOOMER OPEN 仍使用原 PostgreSQL，线上业务不受影响。
- 腾讯云已运行独立的 Supabase 兼容栈，PostgreSQL 为 17.6。
- 腾讯库已重放 ERP 的 106 条迁移。
- Lovable 生产的 92 张 `public` 表在腾讯库全部存在，逐字段无差异。
- 腾讯库额外包含 `store_development_*` 开店管理域。
- BOOMER OPEN 的 3 个项目、18 个阶段、45 个任务、2 条费用和
  13 份附件元数据已迁入。
- BOOMER OPEN 每 5 分钟同步一次；源数据未变化时不执行数据库写入。
- PostgreSQL 每天自动备份，平台每 5 分钟执行健康检查。
- `data.boomeroff.top` 尚未切换为生产入口。

## 为什么不能直接换一个 PostgreSQL 地址

Lovable ERP 依赖的不只是 PostgreSQL：

- Supabase Auth 和 `auth.users`
- PostgREST / Supabase Data API
- RLS 与 JWT 权限
- Storage bucket、对象元数据和 signed URL
- RPC、触发器、`pg_cron`、`pg_net`

因此腾讯目标是 Supabase 兼容栈，而不是一台裸 PostgreSQL。

## 正式迁移需要的源端材料

只接受 Supabase 官方迁移链路，不使用页面 API 拼装业务数据：

1. Lovable 数据库临时只读连接串，或官方导出的：
   - `roles.sql`
   - `schema.sql`
   - `data.sql`
2. Lovable Storage 的 S3 迁移凭证：
   - endpoint
   - region
   - access key id
   - secret access key

临时凭证只放在本机安全存储和腾讯服务器的 `0600` 环境文件，不进入
Git、聊天记录或客户端代码。迁移完成后立即吊销。

## 迁移阶段

### M1：全量演练

1. 对 Lovable 做 roles/schema/data 三段式官方备份。
2. 在腾讯恢复实例中完整还原。
3. 使用 S3 协议复制 6 个 Storage bucket。
4. 对账：
   - 92 张业务表及其行数
   - 4 个 Auth 用户
   - 1060 个 Storage 对象
   - 42 个函数
   - 125 条 RLS policy
   - 38 个生产触发器
5. 运行 ERP 登录、库存、商品图片、订单、收银、手持设备的只读冒烟测试。

### M2：增量观察

1. Lovable 保持主写。
2. 变更数据持续同步到腾讯。
3. 每日比较库存、订单、收银流水和文件对象。
4. 连续 7 天无差异后申请切换。

### M3：正式切换

1. 进入短暂维护窗口，暂停 Lovable 写入。
2. 执行最终数据库和 Storage 增量。
3. 再次核对关键业务表。
4. 发布腾讯 API 域名和新客户端配置。
5. 恢复写入并执行真实业务冒烟：
   - 登录与库位权限
   - 拍照建商品与图片读取
   - RFID 入库和调拨
   - POS 销售、支付、退款
   - 标签与小票打印

### M4：回滚保护

- Lovable 保留只读至少 30 天。
- 切换后发现关键差异，立即把客户端配置恢复到 Lovable。
- 腾讯数据库回滚使用切换前备份，不在活动库上测试恢复。
- COS 对象不删除，使用版本控制处理误覆盖。

## 当前不可切换项

- Lovable 的 Auth 和 Storage 尚未做全量快照恢复。
- 有赞库存 worker 仍指向 Lovable；腾讯数据库内已阻断旧地址，防止测试库
  误推生产库存。
- `data.boomeroff.top` 尚未配置正式 TLS 与生产客户端。

在这些项目完成前，腾讯库只承担迁移演练和开店系统同步，不作为 ERP
生产写入端。

## 给 Lovable 的一次性请求

```text
【BOOMER ERP 数据迁移导出请求】

我们正在把 Lovable 当前 Supabase 数据迁移到腾讯云自托管 Supabase 兼容环境。
请不要修改业务表，也不要新开发迁移接口，只需提供官方导出能力：

1. 为当前生产数据库提供一个限时、可吊销的只读 PostgreSQL 连接串，
   允许使用 Supabase CLI 执行 roles/schema/data 三段式 dump；
   如果平台不能提供连接串，请直接提供 roles.sql、schema.sql、data.sql。
2. 为当前 6 个 Storage bucket 提供限时 S3 迁移凭证：
   endpoint、region、access key id、secret access key。
3. 请确认导出对应的生产项目是
   project 2158bffa-7f82-4bc6-9df9-c59319d262f7，
   PostgreSQL 17.6，并标明导出时间。
4. 凭证通过私密渠道发送，不写入仓库、聊天正文或前端环境变量。

本次只做只读导出，不切换生产、不暂停业务、不修改 Lovable 数据。
```
