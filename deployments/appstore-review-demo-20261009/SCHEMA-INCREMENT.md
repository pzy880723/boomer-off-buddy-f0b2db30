# App Store 审核演示库 · 增量结构（仅限 boomer-review 独立实例）

基线：目标库已含 `supabase/migrations` 至 `20260731070000`（仅结构、零行）。
禁止用于生产 Lovable Cloud、腾讯现网或现有迁移目标实例。

## 执行顺序（Codex 现场）
1. `REVIEW_DATABASE_URL=... BOOMER_REVIEW_ISOLATED=true bash apply-increment.sh --dry-run`
2. 同上去掉 `--dry-run`：按 `schema-increment.manifest` 逐文件单事务执行，记录于 `review_demo.schema_log`，重跑自动跳过、文件改动即报错。
3. `psql ... -v hq_user_id=<uuid> -v staff_user_id=<uuid> -f seed.sql`

脚本会拒绝：未设隔离开关、URL 指向生产/托管库、Auth 用户 >10、存在有赞店铺/真实客户/非演示订单、目标不在基线。

## 清单内容
- 104 个 `supabase/migrations`（20260801 起）+ 48 个 `drizzle/migrations`（0000–0047，含 0046 AI 授权、0047 详情图 actor）。
- 跳过 4 个逐字节重复文件：门店支付主体 `20260801135327`、标准目录 `20260803173000`、会员核心 `20260817120000`、12.9 价位 `20260908070711`。
- `supplement-prod-drift.sql`：生产存在但仓库无任何迁移创建的结构（只读拷贝定义，无数据）——`inv_categories.shipping_fragile`；`pos_customer_coupons.scope/location_id/reserved_order_id` 及约束；`commerce_membership_admin_audit_logs`；6 个函数（会员后台调整、券预留守卫/释放、分店运费报价、可用券、结算报价）及 2 个触发器，EXECUTE 仅 service_role。
- 增量会写入通用标准分类、价位与标准品目录、会员方案/券定义、编辑频道等参考行；不含任何真实门店、客户、订单、账号。

## 基线之前的风险（目标库已存在，勿补跑）
- `20260518050115` / `20260518052105` 写入真实总部账号，永不在演示库执行。
- `20260704153607` 末段创建调用正式有赞地址的 pg_cron 任务；若演示库存在该 job，必须停用/删除。

## 本地验证
`bash tests/sql/review_demo/run.sh`：本地隔离 PG 回放基线→清空全部行→增量两轮→seed 两轮，结果 163 表、0046/0047 就位、非演示业务行 0、两类拒绝守卫生效。
