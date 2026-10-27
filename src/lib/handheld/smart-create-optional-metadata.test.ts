import test from 'node:test';
import assert from 'node:assert/strict';
import { SmartCreateReq } from './schemas';

const minimal = { name: '未分类拍图商品', price_tier: 59.9, is_custom_price: true };
test('title and valid price accept omission of every optional business field', () => {
  const parsed = SmartCreateReq.parse(minimal);
  assert.equal(parsed.name, minimal.name);
  assert.equal(parsed.price_tier, 59.9);
  assert.equal(parsed.category, undefined);
  assert.deepEqual(parsed.attributes, {});
});
test('empty or null category means no classification, not a fabricated category', () => {
  for (const category of ['', null]) assert.equal(SmartCreateReq.parse({ ...minimal, category }).category, undefined);
});
test('empty and whitespace titles remain invalid', () => {
  for (const name of ['', '  ']) assert.equal(SmartCreateReq.safeParse({ ...minimal, name }).success, false);
});
test('invalid prices fail without optional metadata', () => {
  for (const price_tier of [0, -1, 59.999, 1_000_000, NaN, Infinity, '59.9']) {
    assert.equal(SmartCreateReq.safeParse({ ...minimal, price_tier }).success, false);
  }
});