## 问题

我上一轮新写的 `probeShopChainOrgList`（`src/lib/integration-capabilities.functions.ts` 第 635 行）用的是原生 `fetch(url, ...)`，直接从 Cloudflare Worker 出口打有赞，绕开了我们已经接好的固定出口代理（`YOUZAN_PROXY_URL` / `youzanFetch`）。所以有赞看到的是随机的 Worker 出口 IP，不在白名单里，才会一直卡。

项目里其他所有有赞调用（`youzan.functions.ts` 的 `callYouzanApi`、拿 token、`youzan-outbound.functions.ts` 的探测）都是走 `youzanFetch → YOUZAN_PROXY_URL` 的，只有我这段例外。

## 方案

1. 把 `rawCall` 里的 `fetch(url, ...)` 换成 `youzanFetch(url, ...)`（从 `./youzan-http` 引入）。逻辑不变：仍然自己解析 text/JSON、抓 trace_id、区分 empty/error/ok、按 total 分页、两版本 fallback。
2. 顺手全仓 grep 一遍，确认除了 `youzan-outbound.functions.ts` 里明确要打「代理自己那台机器」的那次 `fetch(proxyUrl, …)` 之外，没有其它直连 `open.youzanyun.com` 的漏网之鱼。
3. `src/lib/youzan.functions.ts:214` 的 `fetch(${opts.origin}/api/public/hooks/youzan-sync-worker)` 是打我们自己的 Worker 内网，不涉及有赞，保持不动。
4. 不改 UI、不改 DB、不改其它业务分支。

## 给 Codex 的一段话（复制发给 Codex 那边）

```text
【给 Codex 的指令 · 2026-07-12 · 第1条】
背景：Lovable 侧所有有赞 API 调用都必须走我们自建的固定出口代理，才能落在有赞白名单里的固定 IP 上。目前 Lovable 后端读取环境变量 YOUZAN_PROXY_URL / YOUZAN_PROXY_TOKEN，把请求 POST 到代理，代理再回源到 open.youzanyun.com。请求/响应信封结构见 src/lib/youzan-http.ts（ProxyEnvelope：{ url, method, headers, body } → { status, statusText, headers, body|bodyBase64 }）。

请 Codex 侧完成 3 件事，并把结果反馈给我：
1. 补一份《有赞固定出口代理接入文档》，写清楚：代理域名 / 固定出口 IP / 白名单已在有赞后台配置的截图或时间戳 / 允许回源的域名白名单（当前仅 open.youzanyun.com）/ Authorization Bearer 校验方式 / 请求超时与重试策略 / 灰度或回滚方式。文档放在 Codex 侧仓库固定路径，把链接回给我。
2. 校对一次真实运行的固定出口 IP，把这个 IP 同步到有赞开放平台「IP 白名单」——因为我们最近多轮联调仍然出现 234000001，需要你侧确认代理机器的 egress IP 没变、且确实已经在白名单里生效。
3. 反馈两个值给我，我这边会存进 Lovable 的 Secret：YOUZAN_PROXY_URL（对外可访问的 https 入口）、YOUZAN_PROXY_TOKEN（Bearer 校验用）。如果出口 IP 也希望在管理页展示，一并给我 YOUZAN_PROXY_OUTBOUND_IP。

完成后我会把 Lovable 侧最后一处漏走代理的调用（integration-capabilities.functions.ts 里的 chain 组织树探测）改回 youzanFetch，然后重跑 shop.chain.descendent.organization.list 的 1.0.1/1.0.0 联调，届时如果还失败，就是有赞侧权限/组织树未挂，不再是 IP 问题。
```
