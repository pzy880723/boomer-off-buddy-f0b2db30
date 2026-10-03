import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { parseHTML } from "linkedom";
import { PosCatalog, type PosCatalogProps } from "./pos-catalog";

const group = {
  category_code: "porcelain_jp",
  category_name: "日本瓷器",
  image_url: "/japan.jpg",
  subcategories: [],
  prices: [
    { sku_id: "sku-159", price: 15.9 },
    { sku_id: "sku-129", price: 12.9 },
    { sku_id: "sku-99", price: 9.9 },
  ],
};
const base: PosCatalogProps = {
  tab: "standard",
  groups: [group],
  products: [],
  activeCategoryCode: null,
  subcategory: null,
  loading: false,
  error: "",
  onTab: () => {},
  onGroup: () => {},
  onSubcategory: () => {},
  onPrice: () => {},
  onProduct: () => {},
  onRetry: () => {},
};
const render = (props: Partial<PosCatalogProps> = {}) =>
  renderToStaticMarkup(createElement(PosCatalog, { ...base, ...props }));

test("group catalog shows cover/name and no flat SKU price cards", () => {
  const html = render();
  assert.match(html, /日本瓷器/);
  assert.match(html, /src="\/japan.jpg"/);
  assert.doesNotMatch(html, /data-sku-id/);
  assert.ok(html.indexOf("标准商品") < html.indexOf("自定义商品"));
});
test("selected group shows actual IDs and ascending decimal prices", () => {
  const html = render({ activeCategoryCode: group.category_code });
  assert.match(html, /全部标准商品/);
  assert.match(html, /12\.9/);
  assert.ok(html.indexOf('data-sku-id="sku-99"') < html.indexOf('data-sku-id="sku-129"'));
  assert.ok(html.indexOf('data-sku-id="sku-129"') < html.indexOf('data-sku-id="sku-159"'));
});
test("optional category tags are visible before prices without expanding a disclosure", () => {
  const html = render({ activeCategoryCode: group.category_code, groups: [{ ...group,
    subcategories: [{ code: "porcelain_drinkware", name: "散瓷杯具" }],
  }] });
  assert.match(html, /品类标签（可选）/);
  assert.match(html, /不选标签/);
  assert.doesNotMatch(html, /<details/);
  assert.ok(html.indexOf("散瓷杯具") < html.indexOf('data-sku-id="sku-99"'));
  assert.match(html, /aria-pressed="true"[^>]*>不选标签/);
});
test("selected tag is explicit and prices stay available without choosing a tag", () => {
  const sub = { code: "porcelain_drinkware", name: "散瓷杯具" };
  const html = render({ activeCategoryCode: group.category_code,
    groups: [{ ...group, subcategories: [sub] }], subcategory: sub });
  assert.match(html, /aria-pressed="true"[^>]*>散瓷杯具/);
  assert.match(html, /data-sku-id="sku-129"/);
  assert.doesNotMatch(render({ activeCategoryCode: group.category_code }), /disabled/);
});
test("optional tags occupy one horizontal row between category heading and prices", () => {
  const html = render({ activeCategoryCode: group.category_code, groups: [{ ...group,
    subcategories: Array.from({ length: 12 }, (_, i) => ({ code: `tag-${i}`, name: `标签${i}` })),
  }] });
  const { document } = parseHTML(html);
  const row = document.querySelector('[role="group"][aria-label="品类标签（可选）"]')!;
  const choices = row.querySelector('[data-pos-tag-choices]');
  assert.ok(choices, "tag choices need a dedicated horizontally scrollable row");
  assert.match(choices.className, /overflow-x-auto/);
  assert.match(choices.className, /flex-nowrap/);
  assert.doesNotMatch(choices.className, /flex-wrap(?:\s|$)/);
  assert.equal(choices.querySelectorAll("button").length, 13);
  assert.ok(html.indexOf("<h2") < html.indexOf('aria-label="品类标签（可选）"'));
  assert.ok(html.indexOf('aria-label="品类标签（可选）"') < html.indexOf('data-sku-id="sku-99"'));
});
test("loading, errors and empty catalog have different actionable states", () => {
  assert.match(render({ loading: true }), /正在加载/);
  assert.match(render({ error: "目录获取失败" }), /重试/);
  assert.doesNotMatch(render({ loading: true, groups: [] }), /暂无标准商品/);
  assert.match(render({ groups: [] }), /暂无标准商品/);
});
test("type and brand form two optional compact rows before prices", () => {
  const html = render({ activeCategoryCode: group.category_code,
    groups: [{ ...group, subcategories: [{ code: "cup", name: "杯具" }] }],
    brands: [{ id: "noritake", name: "则武" }], brand: null, onBrand: () => {} });
  assert.ok(html.indexOf("类型／器型") < html.indexOf("品牌／窑口"));
  assert.ok(html.indexOf("品牌／窑口") < html.indexOf('data-sku-id="sku-99"'));
  assert.match(html, /不选品牌/);
  assert.match(html, /更多品牌/);
  assert.match(html, /则武/);
  assert.doesNotMatch(html, /h-16 shrink-0|sm:p-5/);
});
test("custom tab cannot display standard SKUs even if endpoint is old", () => {
  const products = [
    {
      sku_id: "a",
      name: "孤品相机",
      product_type: "custom" as const,
      unit_price: 199,
      available_qty: 1,
      image_url: null,
    },
    {
      sku_id: "b",
      name: "不该出现的标准SKU",
      product_type: "standard" as const,
      unit_price: 12.9,
      available_qty: 9999,
      image_url: null,
    },
  ];
  const html = render({ tab: "custom", products });
  assert.match(html, /孤品相机/);
  assert.doesNotMatch(html, /不该出现的标准SKU/);
});
