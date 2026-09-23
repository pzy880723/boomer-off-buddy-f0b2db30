# 缺货退款 SQL 隔离测试

这些用例**只**跑在本机临时启动的空 PostgreSQL 集群里，永远不连生产库，也不需要任何生产凭证。

## 运行

```bash
bash tests/sql/run-sql-tests.sh
```

脚本会自动完成：

1. `tests/sql/harness/setup.sh`：在 `/tmp/shortage-pg` 初始化并启动隔离集群（unix socket `/tmp`，端口 55432，trust 认证，仅本机），生成包装器 `/tmp/psql.sh`。以 root 运行时会自动降权到普通账号（PostgreSQL 不允许 root 启动）。
2. 重建空库 `shortage_test`。
3. 依次加载：
   - `tests/sql/harness/stubs.sql`：本地角色（anon/authenticated/service_role）+ 生产触发器/序列函数的空桩；
   - `tests/sql/harness/schema.sql`：**仅结构**的表定义（无数据、无权限、无所有者、无连接串）；
   - `drizzle/migrations/0003_*.sql`、`0004_*.sql`、`0005_*.sql`：缺货报价与确认退款的真实 RPC；
   - `tests/sql/fixtures.sql`：`t_mk_order` / `t_mk_shortage` 造数函数。
4. 跑 `cases/*.sql` 反例与 `concurrency/*.sh` 并发用例。

## 结构文件来源

`tests/sql/harness/schema.sql` 由 `tests/sql/harness/dump-schema.sh` 生成，使用
`pg_dump --schema-only --no-owner --no-privileges`，只包含缺货退款链路涉及的 13 张表的列与约束。
不含任何业务数据、客户信息、密钥或连接信息，可安全提交与复现。需要跟进结构变更时，在已配置数据库连接的开发环境里重新执行该脚本即可。

## 用例

| 用例 | 断言 |
| --- | --- |
| `cases/01_group_freight_once.sql` | 同组运费最多退一次 |
| `cases/02_missing_snapshot_manual_review.sql` | 缺运费快照 → 人工复核、金额 0，不放行自助确认 |
| `cases/03_refresh_stale_freight_quote.sql` | 发货后含运费的旧报价被安全重算为 goods-only |
| `cases/04_partial_refund_continuation.sql` | 合法的连续部分退款可继续，已全退拒绝 |
| `cases/05_group_freight_not_underrefunded.sql` | 两条 goods-only 旧报价：第二条必须 QUOTE_CHANGED，刷新后整组运费恰好退一次（防漏退） |
| `cases/06_full_refund_closes_order.sql` | 全退关单+审计；部分/失败/处理中不关；重复回调幂等；多次部分合计全退关单；已交接/发货历史不改；已全退禁止拣货/出库；回填只关账本相符订单 |
| `concurrency/group_freight_race.sh` | 并发确认：运费不会被退两次 |
| `concurrency/group_freight_no_underrefund.sh` | 并发确认：后手过期报价被拒，刷新后运费不漏退 |
