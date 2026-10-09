import assert from "node:assert/strict";
import test from "node:test";
import { publicERPInformation } from "./erp-public-information.server.ts";

test("support is public HTML with the approved company support contact", async () => {
  const response = publicERPInformation("support");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /mailto:tonypan@boomeroff\.com/);
  assert.match(html, /宝暮（上海）品牌管理有限公司/);
  assert.doesNotMatch(html, /<script|supabase|Bearer/i);
});

test("privacy preparation clearly identifies providers and unfinished policy status", async () => {
  const html = await publicERPInformation("privacy").text();
  assert.match(html, /Lovable/);
  assert.match(html, /Google Gemini/);
  assert.match(html, /OpenAI/);
  assert.match(html, /审核准备草稿/);
  assert.doesNotMatch(html, /永不保存|绝不用于训练|立即删除/);
  assert.match(html, /viewport/);
});

test("privacy discloses optional Firecrawl model-era research and outbound consent checks", async () => {
  const html = await publicERPInformation("privacy").text();
  assert.match(html, /生成商品详情需要查证型号年代时/);
  assert.match(html, /授权范围内向 Firecrawl 发送公开品牌官网域名和单一型号检索词/);
  assert.match(html, /可选查询不发送商品照片或客户消息/);
  assert.match(html, /每次查询出站前均重新校验当前员工账号及政策版本的 AI 许可/);
  assert.match(html, /未获许可或许可状态无法核实时不发送查询/);
  assert.match(html, /href="https:\/\/www\.firecrawl\.dev\/privacy-policy">Firecrawl 隐私说明/);
  assert.doesNotMatch(await publicERPInformation("support").text(), /Firecrawl/);
});

test("Firecrawl disclosure retains draft status and makes no unverified processing promises", async () => {
  const html = await publicERPInformation("privacy").text();
  assert.match(html, /审核准备草稿，尚非正式生效的隐私政策/);
  assert.match(html, /Firecrawl 实际适用的供应商条款、处理地域、保留、删除及训练规则仍在核验/);
  assert.match(html, /第三方通用条款不代替本项目实际适用合同和配置/);
  assert.doesNotMatch(html, /零保留|无训练|境内处理|永不保存|绝不用于训练|立即删除/);
});
