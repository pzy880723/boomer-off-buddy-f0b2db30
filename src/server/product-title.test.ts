import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeProductTitle, PRODUCT_TITLE_PROMPT } from "./product-title.server";

test("quick title uses one image, a short budget, and no taxonomy database dependency", async () => {
  const name = await recognizeProductTitle("YWJj", async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_tokens, 256);
    assert.equal(body.messages[1].content.length, 1);
    assert.ok(init?.signal);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"蓝色复古随身听"}' } }] }));
  }, "test-key");
  assert.equal(name, "蓝色复古随身听");
  assert.match(PRODUCT_TITLE_PROMPT, /禁止.*绝版/);
});

test("invalid title response does not become a product name", async () => {
  await assert.rejects(recognizeProductTitle("YWJj", async () => new Response('{"choices":[]}'), "test-key"));
});

test("a fast title without an evidence payload cannot claim rarity", async () => {
  const title = await recognizeProductTitle("YWJj", async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"绝版收藏级蓝色随身听"}' } }] })), "test-key");
  assert.equal(title, "蓝色随身听");
});
