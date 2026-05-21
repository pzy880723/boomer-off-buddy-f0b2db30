# 有赞对接修复 + 体验优化

## 根因（看你截图就能定位）

有赞返回：`Content type 'application/x-www-form-urlencoded' not supported, Please use 'application/json'`。

也就是说我们 `fetchSilentToken` 还在用老的 form 格式发请求，所以总部卡片显示「连接异常」，「一键导入分店」弹窗里也是同一个错。**授权是好的，只是请求格式过时了。**

## 改动清单

### 1. 修 token 请求格式 — `src/lib/youzan.functions.ts`

`fetchSilentToken` 改为发 JSON body：

```ts
const res = await fetch(YZ_OAUTH_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json;charset=UTF-8" },
  body: JSON.stringify({
    client_id, client_secret,
    grant_type: "silent",
    kdt_id: kdtId,
  }),
});
```

同时增强错误解析：有赞这种 HTTP 200 + `{success:false, code:1000, message:"..."}` 的「伪成功」要识别出来，把 `message` 透出来，而不是抛一长串 raw JSON。

### 2. 同步加固 `callYouzanApi` 的错误处理

同样判 `success === false` / `code !== 0`，错误信息更友好。

### 3. UI 小优化（顺手做）

- **总部卡片的「连接异常」**：鼠标 hover 直接显示 `last_ping_msg`，不用点开"高级"。
- **「一键导入分店」弹窗**：错误信息从「无法自动拉取 + 一长串 JSON」改成两段式：
  - 第一行：人话错误标题（如「有赞接口暂时不可用」/「该接口未授权」）
  - 第二行：操作建议 + 折叠的「技术细节」可点开看原始错误。
- **空状态**：刚连上但还没数据时，4 张汇总卡显示「等待首次同步」而不是 0。

### 4. 验证

改完后请你点一次总部卡片的「测试连接」：
- ✅ 显示绿色 + 店铺名 → token 修好了
- ❌ 还有别的错 → 我根据新错误信息再调

然后再点「一键导入分店」看分店列表能不能拉出来（这一步还取决于你在有赞云后台「自用型应用 → 授权店铺」是否勾选了分店 + 该应用是否有 `youzan.retail.shop.list.query` 权限；如果没权限会回退到清晰的引导文案）。

## 不改什么

- 数据库表结构不动
- 汇总统计逻辑不动（Phase B 才接真实同步任务）
- 路由不动
