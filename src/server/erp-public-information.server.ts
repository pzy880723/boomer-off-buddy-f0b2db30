export function publicERPInformation(kind: "privacy" | "support"): Response {
  const title = kind === "privacy" ? "隐私说明 · 审核准备草稿" : "使用帮助与联系";
  const content = kind === "privacy" ? `
    <p class="notice">审核准备草稿，尚非正式生效的隐私政策。供应商处理地域、实际保留和删除规则确认后将更新本页；不得以此草稿代替正式审核资料。</p>
    <h2>适用对象与处理范围</h2>
    <p>BOOMER ERP 面向总部及授权门店员工，账号和业务权限由 ERP 管理员维护。系统为登录、权限、门店业务和审计处理员工姓名、头像、登录联系方式、账号标识、设备绑定标识及操作记录。</p>
    <p>商品、订单及客服功能按授权处理上传照片、商品信息、客户消息及附件、购买记录和必要支付业务资料。员工应避免上传无关的人脸、证件、验证码和付款码。</p>
    <h2>AI 图片与文字处理</h2>
    <p>商品识别、修图、文案和商品卡生成经 ERP 后端将所选图片或文字发送至 Lovable AI 网关，上游涉及 Google Gemini 或 OpenAI。完整处理用途、地域、保留和训练规则仍须核对适用工作区设置及供应商条款，不能仅从模型名称推断。</p>
    <p>生成商品详情需要查证型号年代时，系统可在授权范围内向 Firecrawl 发送公开品牌官网域名和单一型号检索词，查询公开官网资料；此项可选查询不发送商品照片或客户消息。拟发布版本在每次查询出站前重新校验当前员工账号及政策版本的 AI 许可，未获许可或许可状态无法核实时不发送查询。Firecrawl 实际适用的供应商条款、处理地域、保留、删除及训练规则仍在核验。</p>
    <p>原图备份和 AI 处理是不同操作。新版应用正在加入使用前告知、许可选择及撤回入口；该能力尚未正式发布。已发送的任务不能承诺收回，AI 输出应由员工核对后发布。</p>
    <h2>设备权限</h2>
    <p>相机用于拍摄与扫码，相册用于选择或保存商品照片，蓝牙用于连接兼容打印设备。权限应按当前操作请求，不应强制授予无关权限。</p>
    <h2>保留、删除与请求</h2>
    <p>当前源码未显示统一的定时删除任务。图片签名链接或支付请求的有效期，不等于文件及记录的删除期限。实际备份、保留期限和删除流程尚在核实，草稿不对这些未知事项作承诺。</p>
    <p>退出登录不自动删除订单、库存或审计记录。查询、更正、删除或关闭账号的请求，可通过下方公司邮箱联系总部。请勿在初次邮件中发送密码、验证码或完整支付凭据。</p>
    <h2>服务方公开说明</h2>
    <p><a href="https://lovable.dev/privacy/">Lovable 隐私说明</a> · <a href="https://policies.google.com/privacy">Google 隐私说明</a> · <a href="https://openai.com/policies/privacy-policy/">OpenAI 隐私说明</a> · <a href="https://www.firecrawl.dev/privacy-policy">Firecrawl 隐私说明</a>。第三方通用条款不代替本项目实际适用合同和配置。</p>` : `
    <h2>员工登录与门店权限</h2>
    <p>使用 ERP 管理员分配的账号登录。姓名、头像及门店权限在 PC 端 ERP 统一维护。如无法登录或当前库位不正确，请联系总部支持；不要向他人提供密码或验证码。</p>
    <h2>商品、订单与打印</h2>
    <p>仅操作账号获授权的库位。核对价格、商品编码、数量和门店后再上架或调拨。AI 图片与文字需人工核对。打印须连接兼容设备，并使用与打印机设置匹配的标签或小票纸。</p>
    <h2>问题反馈</h2>
    <p>请提供 App 版本、问题发生时间、操作入口、复现步骤及脱敏截图。不要附上客户付款码、账号密码、验证码或证件图片。</p>`;
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BOOMER ERP · ${title}</title>
    <style>body{margin:0;background:#f5f6f8;color:#172231;font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:740px;margin:40px auto;padding:32px;background:white;border:1px solid #e5e8ec;border-radius:20px}h1{font-size:28px;line-height:1.4;margin:12px 0}h2{font-size:19px;margin:28px 0 10px}p{margin:12px 0}a{color:#164e80;overflow-wrap:anywhere}.meta{font-size:13px;color:#657080}.notice{padding:16px;background:#fff5db;border-radius:12px}footer{border-top:1px solid #e5e8ec;margin-top:32px;padding-top:20px}@media(max-width:600px){main{margin:0;border:0;border-radius:0;padding:28px 20px}h1{font-size:24px}}</style></head><body><main>
    <p class="meta">BOOMER ERP · 员工业务工具</p><h1>${title}</h1><p class="meta">运营主体：宝暮（上海）品牌管理有限公司 · 更新：2026-10-09</p>${content}
    <footer><strong>总部支持与隐私请求</strong><p><a href="mailto:tonypan@boomeroff.com">tonypan@boomeroff.com</a></p><p><a href="/support">使用帮助与联系</a> · <a href="/privacy">隐私说明</a></p></footer></main></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  });
}
