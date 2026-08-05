# 手机验证码发送失败 · 只读诊断结果

## 1) 五个变量在 Lovable 项目 Secrets 中的存在状态

| 变量名 | Lovable Secrets |
| --- | --- |
| TENCENTCLOUD_SECRET_ID | SET |
| TENCENTCLOUD_SECRET_KEY | SET |
| TENCENT_SMS_SDK_APP_ID | SET |
| TENCENT_SMS_SIGN_NAME | SET |
| TENCENT_SMS_TEMPLATE_ID | SET |

（值未读取、未输出。）

## 2) 最近一次失败

- `auth_phone_otp` 最新一条记录：2026-08-05 15:31:59 UTC，手机号 186****3310，purpose=login，带 IP。
- 说明请求已到达路由、限流通过、验证码行已成功写库；失败发生在写库之后的短信发送环节。
- 应用运行日志（近 1 小时，published + preview）无任何 otp / sms 记录 —— 该路由的失败分支只返回响应、不写日志，因此拿不到腾讯云侧原始错误码。
- 结合腾讯服务器 PM2 / shared/.env 五项均未配置这一已确认事实，`src/server/sms.tencent.server.ts` 会在调用腾讯 API 之前直接短路返回：
  - HTTP 502，body `{ ok:false, code:"sms_not_configured", message:"短信服务未配置" }`
- 目前没有证据表明存在腾讯云 API 层错误码（如 1400/1401 签名或模板类错误）——请求根本没发出去。

## 3) 是否有可安全同步到腾讯生产的配置

有。这 5 个值在 Lovable Secrets 中均已存在，属于同一套腾讯云短信凭据，可直接同步到腾讯生产的 shared/.env 与 PM2 环境。但 Lovable Secrets 的值加密存储、工具侧不可读取，我无法代为导出；需要由持有腾讯云控制台权限的人从密钥来源处取值填入腾讯服务器，或在 Project Settings → Secrets 中核对后手工复制。

配置到腾讯生产后需要 `pm2 restart boomer-off-buddy --update-env` 才会生效。

## 4) 部署声明

未部署腾讯云，未修改任何代码，未写入数据库，未触发有赞写操作。

## 可选后续（需你确认再执行）

- A. 在 `otp.send` 失败分支加 `console.error` 结构化日志（含腾讯返回 Code/RequestId，不含验证码与密钥），便于下次直接从日志定位。
- B. 增加一个只读自检接口/脚本，返回 5 个变量的 SET/UNSET 状态（不返回值），用于腾讯生产上线前校验。
