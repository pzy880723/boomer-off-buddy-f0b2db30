# 有赞固定出口代理 · 部署与对接手册

本手册包含两部分：
1. **给 Codex 的一次性部署指令**（直接复制发给 Codex）
2. **ERP + 有赞后台侧配置**（由你在 Lovable / 有赞云后台完成）

---

## 一、给 Codex 的部署指令（原样复制到 Codex 会话）

````text
【任务】在我已有的 Linux 服务器上部署一个「有赞固定出口 HTTPS 代理」，让上游 ERP (Lovable/TanStack Start) 所有对 https://open.youzanyun.com 的请求都从这台机器出网，从而只需要把这台机器的公网 IP 加进有赞白名单。

【前置我已经准备好】
- 一台 Linux 服务器（Ubuntu 22.04+ 或 Debian 12+），有 root/sudo；公网固定 IP：<PUBLIC_IP>
- 一个可自由解析的域名，我会把 A 记录 proxy.<mydomain> 指向 <PUBLIC_IP>
- 80/443 端口未被占用

【交付物 —— 完成后请把以下三行原样贴回来给我】
YOUZAN_PROXY_URL=https://proxy.<mydomain>/forward
YOUZAN_PROXY_TOKEN=<你生成的 48 字符随机 token>
YOUZAN_PROXY_OUTBOUND_IP=<这台机器执行 `curl -s ifconfig.me` 得到的公网 IP>

【实现要求】
1. Node.js 20 LTS + Caddy 2（自动 HTTPS）+ systemd。
2. 只允许 POST /forward，且 body.url 主机名必须严格等于 open.youzanyun.com，https 协议；其它一律 400。
3. Bearer Token 鉴权，用 crypto.timingSafeEqual 比较；缺失或错误统一 401，不区分原因。
4. 透传 method / headers / body（文本或 base64），返回 JSON 信封：{status, statusText, headers, body}。
5. 只监听 127.0.0.1:8787，公网只经 Caddy 反代出去。
6. ufw：允许 22/80/443，deny 其它。
7. systemd 服务名 youzan-proxy.service，Restart=always。
8. 部署完执行自检：向自己 /forward 发一次 open.youzanyun.com/oauth/token（不需要真凭据，只要能收到有赞 4xx 回包即可证明链路通）。

【逐步执行】

# 0. 建目录与随机 token
sudo mkdir -p /opt/youzan-proxy && cd /opt/youzan-proxy
TOKEN=$(openssl rand -hex 24)   # 48 字符
echo "PROXY_TOKEN=$TOKEN" | sudo tee /opt/youzan-proxy/.env >/dev/null
sudo chmod 600 /opt/youzan-proxy/.env

# 1. 安装 Node 20 与 Caddy
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy ufw

# 2. 写 server.mjs
sudo tee /opt/youzan-proxy/server.mjs >/dev/null <<'EOF'
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const PORT = 8787;
const TOKEN = process.env.PROXY_TOKEN;
if (!TOKEN) { console.error("PROXY_TOKEN missing"); process.exit(1); }
const ALLOWED_HOST = "open.youzanyun.com";

function checkAuth(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method !== "POST" || req.url !== "/forward") {
      res.writeHead(404); return res.end("not found");
    }
    if (!checkAuth(req)) { res.writeHead(401); return res.end("unauthorized"); }

    const { url, method = "GET", headers = {}, body = null } = await readJson(req);
    if (typeof url !== "string") { res.writeHead(400); return res.end("bad url"); }
    let u;
    try { u = new URL(url); } catch { res.writeHead(400); return res.end("bad url"); }
    if (u.protocol !== "https:" || u.hostname !== ALLOWED_HOST) {
      res.writeHead(400); return res.end(`host not allowed: ${u.hostname}`);
    }

    const init = { method, headers };
    if (body != null) init.body = body;
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    const outHeaders = {};
    upstream.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
      body: text,
    }));
  } catch (e) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message || e) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`youzan-proxy on 127.0.0.1:${PORT}`);
});
EOF

# 3. systemd
sudo tee /etc/systemd/system/youzan-proxy.service >/dev/null <<'EOF'
[Unit]
Description=Youzan Fixed-IP Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/youzan-proxy
EnvironmentFile=/opt/youzan-proxy/.env
ExecStart=/usr/bin/node /opt/youzan-proxy/server.mjs
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now youzan-proxy

# 4. Caddy (把 proxy.<mydomain> 替换成真实域名后再执行)
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
proxy.<mydomain> {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
EOF
sudo systemctl reload caddy

# 5. 防火墙
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# 6. 自检
OUTBOUND_IP=$(curl -s ifconfig.me)
echo "outbound ip = $OUTBOUND_IP"
curl -sS -X POST https://proxy.<mydomain>/forward \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://open.youzanyun.com/oauth/token","method":"POST","headers":{"Content-Type":"application/x-www-form-urlencoded"},"body":"grant_type=silent&client_id=probe"}'
echo
echo "==== 交付回执 ===="
echo "YOUZAN_PROXY_URL=https://proxy.<mydomain>/forward"
echo "YOUZAN_PROXY_TOKEN=$TOKEN"
echo "YOUZAN_PROXY_OUTBOUND_IP=$OUTBOUND_IP"

【验收标准】
- systemctl status youzan-proxy → active (running)
- curl https://proxy.<mydomain>/healthz → {"ok":true}
- 上面的 /forward 自检返回 JSON，其中 body 字段是有赞的错误 JSON（例如 40004/参数错误），不能是 4007（IP 白名单）——如果是 4007，说明这台机器的出网 IP 与 ifconfig.me 报的不一致，请排查 NAT。
- 请把「交付回执」三行原样贴回给我。
````

---

## 二、Codex 交回三行后，你在 Lovable / 有赞后台做的事

### 1. Lovable → Project → Settings → Secrets 新增
- `YOUZAN_PROXY_URL`
- `YOUZAN_PROXY_TOKEN`
- `YOUZAN_PROXY_OUTBOUND_IP`

无需改代码；`youzanFetch` 检测到 `YOUZAN_PROXY_URL` 后自动切换到固定出口代理模式，`/youzan` 顶部会显示「固定出口 <IP>」。

### 2. 有赞云后台 → 应用管理 → IP 白名单
只保留 `YOUZAN_PROXY_OUTBOUND_IP` 这一个；其它历史动态 IP 全部删除。

### 3. 有赞云后台 → 应用能力（按需勾选）

| 分类 | 中文能力名 | 对应 method |
|---|---|---|
| 授权 | 自用型应用授权 (silent) | oauth/token |
| 门店 | 查询店铺基本信息 | youzan.shop.get |
| 连锁 | 连锁 · 查询门店列表 | youzan.retail.shop.list.query |
| 类目 | 查询店铺分组标签 | youzan.itemcategories.tags.get |
| 商品 | 连锁 · 查询总部 SPU | youzan.retail.open.spu.query |
| 商品 | 连锁 · 新增总部 SPU | youzan.retail.open.spu.add |
| 商品 | 连锁 · 查询门店在售 SPU | youzan.retail.open.online.spu.query |
| 库存 | 连锁 · 总部按 kdt_id 更新库存 | youzan.retail.open.stock.update |
| 库存 | 商品库存增减 / 设置 | youzan.item.quantity.update |
| 订单 | 查询已卖出的交易 | youzan.trades.sold.get |

### 4. 验证
打开 `/youzan → API 体检 → 重新体检`：
- 全绿 = 完成。
- 剩下 `gw 4005`：去后台补勾对应行的"能力名"。
- 剩下 `gw 4007`：白名单没加成功，去有赞后台复核 IP。
- 剩下 `token 失败`：授权凭据不对，跟代理无关。
