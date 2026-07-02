## 目标

一次性交付一份完整的「固定出口代理部署 + ERP 侧配置 + 白名单验证」指令包，交给 Codex 在你现有的服务器 + 域名上部署，让所有有赞 API（授权、门店、类目、SPU、库存、订单）都能稳定走固定 IP，通过 `/youzan → API 体检` 全绿。

## 交付物（3 个部分，全部通过本次 `plan--create` 的正文给你复制）

### 一、给 Codex 的部署指令（一次性发过去）

包含：
1. **前置信息**：Node 20 LTS + Caddy + 一个域名（你已有），一台有公网固定 IP 的 Linux 服务器（你已有）。
2. **代理程序 `server.mjs`**：只允许转发到 `open.youzanyun.com`（避免被当开放代理），Bearer Token 鉴权，透传 method/headers/body，返回 `{status, headers, body}` 的 JSON 信封。
3. **systemd 服务**：`youzan-proxy.service`，自启动、崩溃自恢复、日志 journald。
4. **Caddyfile**：`proxy.你的域名` → `127.0.0.1:8787`，自动申请 Let's Encrypt HTTPS。
5. **防火墙**：只开 80/443，8787 只 loopback。
6. **自检脚本**：`curl` 打自己 → 走一次 `auth/token` → 打印回包状态 + 出口 IP（`curl ifconfig.me`）。
7. **交付回执**：Codex 完成后必须回三条信息：
   - `YOUZAN_PROXY_URL=https://proxy.你的域名/forward`
   - `YOUZAN_PROXY_TOKEN=<48 位随机>`
   - `YOUZAN_PROXY_OUTBOUND_IP=<服务器公网 IP>`

### 二、ERP 侧的配置（我在这里明确列出，Codex 不用管）

Codex 交回上面三条后，你在 Lovable：
- Project → Settings → Secrets 添加：`YOUZAN_PROXY_URL`、`YOUZAN_PROXY_TOKEN`、`YOUZAN_PROXY_OUTBOUND_IP`
- 有赞云后台 → 应用管理 → IP 白名单：**只加** `YOUZAN_PROXY_OUTBOUND_IP` 这一个，之前加的动态 IP 全部删掉。
- 有赞云后台 → 应用能力：按下方"必须开通清单"逐项勾选。

### 三、必须在有赞后台勾选的能力清单（体检面板对齐）

来自 `src/lib/youzan-api-registry.ts`，按 `required: true` 精简：

```text
授权         自用型应用授权 (silent / client_credentials)
门店基础     查询店铺基本信息 (youzan.shop.get)
连锁总部     连锁 · 查询门店列表 (youzan.retail.shop.list.query)
类目分组     查询店铺分组标签 (youzan.itemcategories.tags.get)
总部商品库   连锁 · 查询总部 SPU (youzan.retail.open.spu.query)
总部商品库   连锁 · 新增总部 SPU (youzan.retail.open.spu.add)
分店在售     连锁 · 查询门店在售 SPU (youzan.retail.open.online.spu.query)
库存写入     连锁 · 总部按 kdt_id 更新库存 (youzan.retail.open.stock.update)
库存写入     商品库存增减 / 设置 (youzan.item.quantity.update)
订单         查询已卖出的交易 (youzan.trades.sold.get)
```

## 验证闭环（部署完后你只按 3 步）

1. Codex 交回三条值 → 你贴到 Lovable Secrets → 我这边 `youzanFetch` 自动切到"固定出口代理"模式，无需改代码。
2. 在有赞后台把 `YOUZAN_PROXY_OUTBOUND_IP` 加白，勾能力清单。
3. 打开 `/youzan → API 体检 → 重新体检`。全绿 = 完成；如仍有 `gw 4005` 只需去后台补勾对应那一行的"能力名"；如出现 `gw 4007` 说明白名单没加成功（不需要动代码）。

## 技术说明（给 Codex 看的实现要点）

- `server.mjs` 只做一件事：`POST /forward` 收 `{url, method, headers, body}`，校验 `url` 主机名严格等于 `open.youzanyun.com` + `https`，禁止其它 host；拒绝 `FormData`/流式。
- Bearer Token 用 `crypto.timingSafeEqual` 比较；缺失或错误一律 401，不区分原因。
- 返回 `Content-Type: application/json`，body 结构 `{status, statusText, headers, body}`（有赞回包全是文本）。
- 出口 IP 与代理 IP 必须一致（同一台机器出网），否则白名单无效。
- 部署完后跑一次 `curl -s ifconfig.me` 与 Caddy 里的 A 记录对齐。

写完这份计划后，进入 Build 模式我会把"给 Codex 的完整部署指令"作为一段可直接复制的 ```text 块贴给你（含 `server.mjs` 完整源码、systemd unit、Caddyfile、自检脚本、验收标准），你原样丢给 Codex 即可，不用再回来问我。
