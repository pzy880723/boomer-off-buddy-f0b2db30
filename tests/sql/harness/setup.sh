#!/bin/bash
# 隔离测试环境自举：在本机临时目录起一个**空**的 PostgreSQL 集群，
# 并生成 /tmp/psql.sh 包装器。绝不连接生产库，绝不需要任何生产凭证。
#
#   bash tests/sql/harness/setup.sh          # 启动隔离集群
#   bash tests/sql/run-sql-tests.sh          # 跑全部反例 + 并发用例
#
# 表结构来源：tests/sql/harness/schema.sql（仅结构，无任何业务数据、无权限、无所有者）。
# 需要刷新结构时在有数据库连接的环境里执行 tests/sql/harness/dump-schema.sh。
set -euo pipefail

PGDIR=${SHORTAGE_TEST_PGDIR:-/tmp/shortage-pg}
PGPORT_LOCAL=${SHORTAGE_TEST_PGPORT:-55432}

if [ ! -d "$PGDIR/data" ]; then
  mkdir -p "$PGDIR/data"
  initdb -D "$PGDIR/data" -U postgres --auth=trust >/dev/null
fi

if ! pg_ctl -D "$PGDIR/data" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDIR/data" -o "-p $PGPORT_LOCAL -k /tmp -c listen_addresses=''" -l "$PGDIR/pg.log" -w start >/dev/null
fi

cat > /tmp/psql.sh <<EOF
#!/bin/bash
# 只指向本地隔离集群（unix socket /tmp:$PGPORT_LOCAL），与生产库无关。
exec psql -h /tmp -p $PGPORT_LOCAL -U postgres -d "\${PGDB:-shortage_test}" -v ON_ERROR_STOP=1 "\$@"
EOF
chmod +x /tmp/psql.sh
echo "isolated postgres ready on /tmp:$PGPORT_LOCAL (db shortage_test)"
