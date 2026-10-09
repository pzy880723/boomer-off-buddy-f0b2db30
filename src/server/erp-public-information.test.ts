import assert from "node:assert/strict";
import test from "node:test";
import { publicERPInformation } from "./erp-public-information.server.ts";

test("support is public HTML with the approved company support contact", async () => {
  const response = publicERPInformation("support");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/html/);
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
