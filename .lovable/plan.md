# 给 Codex 的指令（复制粘贴给他即可）

Lovable 端已经把「自动检测出口 IP」切到了 `POST /youzan-proxy/forward` + `{ "probe": "whoami" }`，不再打 `open.youzanyun.com/oauth/token`。请你在服务器侧做以下确认和收尾。

## 1. 确认 whoami 分支落地

- `server.mjs` 里 `req.body.probe === "whoami"` 分支必须：
  - 校验 `Authorization: Bearer <YOUZAN_PROXY_TOKEN>`，失败返回 401。
  - 请求 `https://api.ipify.org?format=json`，返回 `{ ok: true, ip, source: "ipify" }`。
  - 不要把 whoami 请求当成 Youzan forward 走出去。

## 2. 加一个健康检查端点

- `GET https://erp.boomeroff.com/youzan-proxy/healthz` 返回 `{ ok: true, ts: <iso> }`，无需 token，便于 Lovable 后续做心跳。

## 3. 有赞白名单收敛

- 把有赞后台 → 应用管理 → IP 白名单里所有历史 IP 删除，只保留 `150.158.94.248`。
- 确认后回我一句「白名单已收敛到 150.158.94.248」。

## 4. 冒烟验证

在服务器上跑一遍，把输出贴回来：

```bash
curl -s -X POST https://erp.boomeroff.com/youzan-proxy/forward \
  -H "Authorization: Bearer $YOUZAN_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"probe":"whoami"}'

curl -s https://erp.boomeroff.com/youzan-proxy/healthz
```

预期第一条返回 `{"ok":true,"ip":"150.158.94.248","source":"ipify"}`。

## 5. 完成后

回我「whoami OK + 白名单已收敛」，我会在 `/youzan → API 体检` 点「重新体检」，把矩阵截图发你确认。
