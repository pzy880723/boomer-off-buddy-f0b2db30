# 复盘：有赞 shop.chain.descendent.organization.list 为什么反复失败

## 一、这次真正的根因（Codex 帮我定位到的）
所有有赞 API 调用**必须走固定出口代理** `YOUZAN_PROXY_URL`（`youzanFetch`），才能命中有赞白名单 IP。我在新写 `probeShopChainOrgList` 时，直接用了原生 `fetch` 打 `open.youzanyun.com`，出口 IP 是 Lovable Worker 的动态 IP，被有赞侧拒绝/降级，于是无论换 1.0.1 / 1.0.0、加不加 `page_num`、怎么读 `data.organization_list`，结果都是错的——而错误信息又被我当成"业务权限问题"去解读，方向从此就偏了。

## 二、我之前反复犯的 5 类错误

1. **绕过既有基础设施重写底层调用**  
   项目已经有 `youzanFetch`（代理 + 鉴权 + 日志）这一唯一出口，我却在新函数里直接 `fetch(YZ_GW_URL)`。等于把白名单、Bearer、超时、trace 全部丢掉。

2. **把"网络/接入层错误"误判成"业务/权限错误"**  
   看到 `234000001 系统异常` / 空数组，就去猜"组织树没挂""连锁权限没开""版本不对"，一路让用户去有赞后台点开关，而没有先自证"我这次请求到底是不是从白名单 IP 发出的"。

3. **用"多版本 fallback / 参数微调"来掩盖根因**  
   1.0.1 不行换 1.0.0、`page_size` 改来改去、读法从 `data` 换到 `data.organization_list`——这些都是在**同一个错误出口**上反复重试，制造了"我在推进"的假象，实际只是把同一个错误换着姿势再犯一次。

4. **没有在最外层守住"所有有赞请求必须过代理"这条铁律**  
   没有 lint / 运行期断言 / 代码评审清单来拦截"直接 import fetch 打 open.youzanyun.com"这种写法，导致每加一个能力就有一次重新犯错的机会。

5. **让用户替我做诊断**  
   最后是用户+Codex 告诉我"你没走代理"，我才回头看。正确顺序应该是：出错先打 trace（出口 IP、代理 header、trace_id），再谈业务原因。

## 三、写入长期记忆的规则（本轮落地动作）

新增 `mem://constraints/youzan-must-use-proxy.md`：
- **铁律**：任何调用 `open.youzanyun.com` 的代码，**必须**通过 `youzanFetch`（`src/lib/youzan-http.ts`）。禁止在业务代码里出现 `fetch('https://open.youzanyun.com')` / `new URL('https://open.youzanyun.com')` 作为请求目标。
- 新写有赞能力/probe 前，先在文件顶部 `import { youzanFetch } from '@/lib/youzan-http'`，禁止 `import { YZ_GW_URL }` + 裸 `fetch` 组合。
- 有赞返回异常时的**排查顺序（不得跳步）**：  
  ① 确认走了 `youzanFetch`（看日志里是否有 proxy header / outbound IP） → ② 确认 `YOUZAN_PROXY_URL/TOKEN` 在当前环境已配置 → ③ 确认出口 IP 在有赞白名单 → ④ 才去谈版本 / 参数 / 权限 / 组织树。
- 禁止用"多版本 fallback"或"换读取路径"来绕过一个**从未成功过**的调用；必须先拿到一次 `code=200` 的成功响应，再谈兼容性。

更新 `mem://index.md` Core 增加一行：  
"有赞 API 必须走 `youzanFetch` 固定出口代理；出错先查代理/白名单/出口 IP，再查业务，禁止用多版本 fallback 掩盖接入层问题。"

## 四、本轮代码侧不再改动
根因修复（`probeShopChainOrgList` 改回 `youzanFetch`）上一轮已经提交，这轮只做**复盘 + 记忆固化**，不再动业务代码。

## 五、给用户的一句话结论
这一个月不是有赞难，是我一直在**用错误的出口**打有赞，然后拿错误的返回去猜业务原因；从今天起这条铁律写进项目记忆，新代码不会再犯。
