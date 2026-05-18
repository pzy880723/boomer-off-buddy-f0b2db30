我查到现在不是密码错，也不是后台没起来，而是上一轮迁移把手机号账号写进了认证表时，有几个 token 字段被写成了 NULL。认证服务读取用户时遇到 `confirmation_token` 为 NULL 会直接 500，所以登录请求失败。

计划如下：

1. 修复超级管理员认证数据
   - 把 `18657433310@users.local` 这条账号的认证 token 字段统一修正为空字符串，而不是 NULL。
   - 保留现有密码不变。
   - 保留手机号 `18657433310` 和内部邮箱映射。

2. 顺手修正上一轮迁移方式
   - 避免以后再直接把这些认证字段写成 NULL。
   - 不再旋转密钥，不再改发布配置，不动业务数据。

3. 验证登录链路
   - 再查一次认证日志，确认不再出现 `Database error querying schema`。
   - 登录页仍然保持用户看到的是“手机号 + 密码”，内部用邮箱映射只是为了绕过短信登录开关。

技术细节：
- 当前失败日志是：`error finding user: sql: Scan error on column index 3, name "confirmation_token": converting NULL to string is unsupported`。
- 数据库里 `18657433310@users.local` 的 `confirmation_token` / `recovery_token` 等字段现在有 NULL，需要改成空字符串。