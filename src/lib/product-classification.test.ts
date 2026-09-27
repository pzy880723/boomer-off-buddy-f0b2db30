import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  activeLeafCategories,
  formatTaxonomyForPrompt,
  normalizeProductRecognition,
  type CategoryNode,
  type RawProductRecognition,
} from "./product-classification";
import type { BrandCandidate, FacetTerm } from "./product-taxonomy";

describe("image date markings", () => {
  const raw = { category_code: "toy_character_figure", confidence: 0.95, attributes: { era: "Heisei" } };
  const mark = (text: string, years: number[], kind: string, image_index = 1) => ({ text, years, kind, image_index });
  const normalize = (date_markings: unknown, imageCount = 3) => normalizeProductRecognition(
    { ...raw, date_markings } as RawProductRecognition, categories, undefined, { imageCount },
  );
  test("manufacturing evidence on later uploaded images beats era and character copyright", () => {
    const result = normalize([mark("©1975 SANRIO", [1975], "character"), mark("製造年月 2020年06月", [2020], "manufacturing", 3)]);
    assert.equal(result.attributes.era, "2020年（生产年份）");
    assert.equal(result.attributes.date_markings?.[1].image_index, 3);
    assert.ok(result.evidence.some((text) => text.includes("图3") && text.includes("製造年月 2020年06月")));
    assert.equal(result.status, "auto_classified");
  });
  test("Sanrio multi-year copyright remains a copyright marking, never a manufacture assertion", () => {
    const markings = [mark("©1975,2020 SANRIO", [1975, 2020], "copyright", 2)];
    const result = normalize(markings);
    assert.equal(result.attributes.era, "2020年（版权标注）");
    assert.deepEqual(result.attributes.date_markings, markings);
    assert.ok(result.evidence.some((text) => text.includes("©1975,2020 SANRIO")));
    assert.doesNotMatch(result.attributes.era!, /生产/);
  });
  test("a lone character/initial copyright year cannot date the item", () => {
    for (const kind of ["character", "copyright", "unknown"]) {
      const result = normalize([mark("©1975 SANRIO", [1975], kind)]);
      assert.equal(result.attributes.era, null);
      assert.ok(result.clarification_requests.some((item) => item.field === "era"));
      assert.equal(result.status, "auto_classified");
    }
  });
  test("copyright cannot be relabelled manufacturing by the model", () => {
    const result = normalize([mark("©1975,2020 SANRIO", [1975, 2020], "manufacturing")]);
    assert.equal(result.attributes.era, "2020年（版权标注）");
  });
  test("single label year is displayed with its limited nature", () => {
    assert.equal(normalize([mark("2020年 商品标签", [2020], "label")]).attributes.era, "2020年（标签标注）");
  });
  test("multiple manufacture years conflict instead of choosing the latest", () => {
    const result = normalize([mark("MFG 2019", [2019], "manufacturing"), mark("MFG 2020", [2020], "manufacturing", 2)]);
    assert.equal(result.attributes.era, null);
    assert.ok(result.clarification_requests.some((item) => /冲突/.test(item.reason ?? "")));
    assert.equal(result.attributes.date_markings?.length, 2);
  });
  test("copyright years differing across photos do not choose the largest", () => {
    assert.equal(normalize([mark("©1975,2020 SANRIO", [1975, 2020], "copyright"), mark("©1975,2021 SANRIO", [1975, 2021], "copyright", 2)]).attributes.era, null);
  });
  test("invalid image references or invented/unreadable years cannot establish an era", () => {
    for (const entry of [mark("MFG 2020", [2020], "manufacturing", 99), mark("MFG 2020", [2020], "manufacturing", 0), mark("MFG 2020", [2020], "manufacturing", 1.5), mark("MFG 20??", [2020], "manufacturing"), mark("MFG 2019", [2020], "manufacturing"), mark("2020", [2020], "manufacturing")]) {
      assert.equal(normalize([entry]).attributes.era, null);
    }
    assert.equal(normalize([mark("MFG 2020", [2020], "manufacturing", 3)], 2).attributes.era, null);
  });
  test("new model evidence-free Heisei is suppressed, legacy romanization is localized only", () => {
    assert.equal(normalize([]).attributes.era, null);
    assert.equal(normalizeProductRecognition(raw, categories, undefined, { imageCount: 1 }).attributes.era, null);
    assert.equal(normalizeProductRecognition(raw, categories).attributes.era, "平成（1989–2019年）");
  });
  test("new date evidence removes speculative era facets and contradictory description claims", () => {
    const result = normalizeProductRecognition({ ...raw, description: "凯蒂猫挂件；1975年生产，Heisei风格。", date_markings: [mark("©1975,2020 SANRIO", [1975,2020], "copyright")], facet_predictions: [{ dimension: "era", value: "Heisei" }] } as RawProductRecognition,
      categories, { facets: [{ code: "era_heisei", name: "平成", dimension: "era", aliases: ["Heisei"] }], brands: [], ips: [] }, { imageCount: 1 });
    assert.deepEqual(result.facets, []);
    assert.doesNotMatch(result.description ?? "", /1975|Heisei/);
    assert.match(result.description ?? "", /凯蒂猫/);
  });
  test("description guard preserves ordinary product numbers and useful prose", () => {
    const description = "Sony PSP-3000游戏机，配备3000mAh电池；带2个按钮。";
    const result = normalizeProductRecognition({ ...raw, description, date_markings: [] }, categories, undefined, { imageCount: 1 });
    assert.equal(result.description, description);
  });
  test("explicit Heisei year is converted without losing manufacture versus label nature", () => {
    assert.equal(normalize([mark("製造年月 平成10年", [1998], "manufacturing")]).attributes.era, "1998年（生产年份）");
    assert.equal(normalize([mark("平成10年 商品标签", [1998], "label")]).attributes.era, "1998年（标签标注）");
    assert.equal(normalize([mark("製造年月 平成32年", [2020], "manufacturing")]).attributes.era, null);
  });
  test("abbreviated copyright years retain literal evidence without guessing centuries", () => {
    const result = normalize([mark("©’76,’20 SANRIO", [1976,2020], "copyright")]);
    assert.equal(result.attributes.era, null);
    assert.equal(result.attributes.date_markings?.[0].text, "©’76,’20 SANRIO");
    assert.deepEqual(result.attributes.date_markings?.[0].years, []);
  });
  test("multi-year copyright symbol stays copyright even if model calls it character origin", () => {
    assert.equal(normalize([mark("©1975,2020 SANRIO", [1975,2020], "character")]).attributes.era, "2020年（版权标注）");
  });
  test("separate character copyrights and negative manufacturing text do not establish item dates", () => {
    for (const entry of [mark("Hello Kitty ©1975; My Melody ©1976", [1975,1976], "copyright"), mark("Not manufactured in 2020", [2020], "manufacturing"), mark("MFG 2020?", [2020], "manufacturing"), mark("製造年月不明（2020年購入）", [2020], "manufacturing"), mark("manufactured before 2020", [2020], "manufacturing")]) {
      assert.equal(normalize([entry]).attributes.era, null);
    }
  });
  test("full-width unsupported manufacturing claim is removed without changing model numbers", () => {
    const result = normalizeProductRecognition({ ...raw, description: "Sony PSP-3000，3000mAh电池；１９７５年制造。", date_markings: [mark("©1975,2020 SANRIO", [1975,2020], "copyright")] }, categories, undefined, { imageCount: 1 });
    assert.doesNotMatch(result.description ?? "", /１９７５/);
    assert.match(result.description ?? "", /PSP-3000，3000mAh/);
  });
  test("only matching manufacture-backed existing era facets survive", () => {
    const taxonomy = { facets: [{ code: "era_heisei", name: "平成", dimension: "era" as const, aliases: ["Heisei"] }, { code: "era_showa", name: "昭和", dimension: "era" as const, aliases: ["Showa"] }], brands: [], ips: [] };
    for (const [marking, expected] of [[mark("MFG 1998", [1998], "manufacturing"), ["era_heisei"]], [mark("MFG 1980", [1980], "manufacturing"), ["era_showa"]], [mark("©1975,1998", [1975,1998], "copyright"), []]] as const) {
      const result = normalizeProductRecognition({ ...raw, date_markings: [marking], facet_predictions: [{ dimension: "era", value: "Heisei" }, { dimension: "era", value: "Showa" }] }, categories, taxonomy, { imageCount: 1 });
      assert.deepEqual(result.facets.map((facet) => facet.code), expected);
    }
  });
});

const categories: CategoryNode[] = [
  { id: "root-p", code: "porcelain", name: "瓷器", parent_id: null, is_active: true },
  {
    id: "p-eu",
    code: "porcelain_europe",
    name: "欧洲瓷器",
    parent_id: "root-p",
    is_active: true,
  },
  {
    id: "p-unknown",
    code: "porcelain_origin_unknown",
    name: "产地待确认",
    parent_id: "root-p",
    is_active: true,
  },
  { id: "root-t", code: "toy_model", name: "玩具模型", parent_id: null, is_active: true },
  {
    id: "toy-figure",
    code: "toy_character_figure",
    name: "角色人偶/软胶",
    parent_id: "root-t",
    is_active: true,
  },
  {
    id: "toy-off",
    code: "toy_inactive",
    name: "已停用玩具",
    parent_id: "root-t",
    is_active: false,
  },
  {
    id: "root-off",
    code: "inactive_root",
    name: "已停用一级",
    parent_id: null,
    is_active: false,
  },
  {
    id: "orphan-active",
    code: "orphan_active",
    name: "孤立子类",
    parent_id: "root-off",
    is_active: true,
  },
  {
    id: "root-pending",
    code: "classification_pending",
    name: "待归类",
    parent_id: null,
    is_active: true,
  },
  {
    id: "pending-low",
    code: "ai_low_confidence",
    name: "AI低置信度",
    parent_id: "root-pending",
    is_active: true,
  },
  {
    id: "pending-compliance",
    code: "compliance_review",
    name: "合规待审",
    parent_id: "root-pending",
    is_active: true,
  },
];

const facets: FacetTerm[] = [
  { code: "origin_uk", name: "英国", dimension: "origin", aliases: ["UK", "England"] },
  {
    code: "material_bone_china",
    name: "骨瓷",
    dimension: "material",
    aliases: ["Bone China"],
  },
  { code: "craft_gilt", name: "描金", dimension: "craft", aliases: ["金彩"] },
];

const brands: BrandCandidate[] = [
  {
    id: "brand-wedgwood",
    name: "Wedgwood",
    name_original: null,
    aliases: ["韦奇伍德"],
  },
];

const ips: BrandCandidate[] = [
  {
    id: "ip-hello-kitty",
    name: "Hello Kitty",
    name_original: null,
    aliases: ["凯蒂猫", "Kitty"],
  },
];

// Sanrio is a parent IP in the existing taxonomy, not a new brand identity.
const sanrio: BrandCandidate = {
  id: "existing-sanrio-parent",
  name: "三丽鸥 (Sanrio)",
  name_original: "Sanrio",
  aliases: ["三丽鸥"],
};
const kittyTaxonomy = { facets, brands, ips: [...ips, sanrio] };
const kittyRecognition: RawProductRecognition = {
  category_code: "toy_character_figure",
  confidence: 0.94,
  name: "Hello Kitty 挂件",
  ip_name: "Hello Kitty",
};

describe("bounded Hello Kitty recognition brand", () => {
  for (const ipName of ["Hello Kitty", "hello kitty", "凯蒂猫", "Kitty"]) {
    test(`fills the existing Sanrio brand for the exact character alias ${ipName}`, () => {
      const raw = { ...kittyRecognition, ip_name: ipName, attributes: { brand: null } };
      const result = normalizeProductRecognition(raw, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, sanrio.name);
      assert.equal(result.brand_id, sanrio.id);
      assert.equal(result.brand_match_status, "matched");
      assert.equal(result.brand_candidate_text, sanrio.name);
      assert.equal(result.ip_id, "ip-hello-kitty");
      assert.equal(result.ip_name, "Hello Kitty");
      assert.equal(raw.attributes.brand, null);
    });
  }

  test("uses the canonical row supplied by the taxonomy, including name-only parent rows", () => {
    for (const name of ["三丽鸥 (Sanrio)", "三丽鸥", "Sanrio"]) {
      const parent = { ...sanrio, id: `loaded-${name}`, name, name_original: null, aliases: [] };
      const result = normalizeProductRecognition(kittyRecognition, categories, {
        facets, brands: [...brands, parent], ips,
      });
      assert.equal(result.brand_id, parent.id);
      assert.equal(result.attributes.brand, parent.name);
    }
  });

  test("matches explicit Sanrio text to the parent IP without replacing the character", () => {
    const result = normalizeProductRecognition({
      ...kittyRecognition, attributes: { brand: "Sanrio" },
    }, categories, kittyTaxonomy);
    assert.equal(result.brand_id, sanrio.id);
    assert.equal(result.attributes.brand, "Sanrio");
    assert.equal(result.ip_id, "ip-hello-kitty");
  });

  test("preserves explicit conflicting brands, including a top-level brand beside blank nested text", () => {
    for (const raw of [
      { attributes: { brand: "Wedgwood" } },
      { attributes: { brand: "Unknown Collaboration" } },
      { brand: "Wedgwood" },
      { brand: "Wedgwood", attributes: { brand: "  " } },
    ]) {
      const expected = raw.attributes?.brand.trim() || raw.brand;
      const result = normalizeProductRecognition({ ...kittyRecognition, ...raw }, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, expected);
      assert.equal(result.brand_id, expected === "Wedgwood" ? "brand-wedgwood" : null);
      assert.equal(result.ip_name, "Hello Kitty");
    }
  });

  test("does not infer from a title, a fuzzy character, another character, or the parent IP alone", () => {
    for (const ip_name of [null, "Hello Kity", "Hello Kitty x Other Character", "三丽鸥", "My Melody"]) {
      const result = normalizeProductRecognition({ ...kittyRecognition, ip_name }, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, null);
      assert.equal(result.brand_id, null);
    }
  });

  test("does not infer from low or missing confidence or unresolved brand/character questions", () => {
    const uncertain: Partial<RawProductRecognition>[] = [
      { confidence: 0.4 },
      { confidence: null },
      { attribute_confidence: { ip_name: 0.3 } },
      { attribute_confidence: { ip_name: null } },
      { clarification_requests: [{ field: "ip_name", question: "Confirm character?" }] },
      { clarification_requests: [{ field: "brand", question: "Confirm collaboration brand?" }] },
    ];
    for (const raw of uncertain) {
      const result = normalizeProductRecognition({ ...kittyRecognition, ...raw }, categories, kittyTaxonomy);
      assert.equal(result.attributes.brand, null);
      assert.equal(result.brand_id, null);
    }
  });

  test("can use confident character evidence even when the category is uncertain", () => {
    const result = normalizeProductRecognition({
      ...kittyRecognition, confidence: 0.5, attribute_confidence: { ip_name: 0.96 },
      clarification_requests: [{ field: "era", question: "Confirm era?" }],
    }, categories, kittyTaxonomy);
    assert.equal(result.status, "fallback");
    assert.equal(result.brand_id, sanrio.id);
  });

  test("never invents parent or character identities when taxonomy rows are absent", () => {
    for (const taxonomy of [
      { facets, brands, ips },
      { facets, brands, ips: [sanrio] },
      { facets, brands, ips: [{ ...sanrio, aliases: ["Hello Kitty"] }] },
    ]) {
      const result = normalizeProductRecognition(kittyRecognition, categories, taxonomy);
      assert.equal(result.attributes.brand, null);
      assert.equal(result.brand_id, null);
    }
  });
});

describe("product classification policy", () => {
  test("only exposes active leaves whose parent is active", () => {
    assert.deepEqual(
      activeLeafCategories(categories).map((row) => row.code),
      [
        "porcelain_europe",
        "porcelain_origin_unknown",
        "toy_character_figure",
        "ai_low_confidence",
        "compliance_review",
      ],
    );
  });

  test("formats the live two-level taxonomy for the AI prompt", () => {
    const text = formatTaxonomyForPrompt(categories);
    assert.match(text, /porcelain_europe \| 瓷器 > 欧洲瓷器/);
    assert.doesNotMatch(text, /toy_inactive/);
    assert.doesNotMatch(text, /orphan_active/);
  });

  test("keeps a valid high-confidence leaf classification", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "porcelain_europe",
        confidence: 0.94,
        name: "英国描金骨瓷茶杯碟",
        attributes: { origin_region: "欧洲", origin_country: "英国" },
      },
      categories,
    );

    assert.equal(result.category_code, "porcelain_europe");
    assert.equal(result.status, "auto_classified");
    assert.equal(result.attributes.origin_country, "英国");
  });

  test("uses porcelain unknown-origin when the object is porcelain but origin is unclear", () => {
    const result = normalizeProductRecognition(
      {
        category_code: null,
        confidence: 0.86,
        name: "描金花卉纹茶杯",
        attributes: { material: ["瓷"], object_type: "茶杯" },
      },
      categories,
    );

    assert.equal(result.category_code, "porcelain_origin_unknown");
    assert.equal(result.status, "fallback");
  });

  test("uses the new object-based porcelain fallback after origin categories are retired", () => {
    const modernCategories = categories.map((row) =>
      row.code === "porcelain_origin_unknown"
        ? { ...row, code: "porcelain_other", name: "其他陶瓷物件" }
        : row,
    );
    const result = normalizeProductRecognition(
      {
        category_code: null,
        confidence: 0.88,
        name: "无底款陶瓷摆件",
        attributes: { material: ["陶瓷"], object_type: "摆件" },
      },
      modernCategories,
    );

    assert.equal(result.category_code, "porcelain_other");
  });

  test("uses the low-confidence leaf when confidence is below the automatic threshold", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.6,
        name: "红色软胶玩具",
      },
      categories,
    );

    assert.equal(result.category_code, "ai_low_confidence");
    assert.equal(result.status, "fallback");
    assert.equal(result.predicted_category_code, "toy_character_figure");
  });

  test("compliance flags override an otherwise valid category", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "porcelain_europe",
        confidence: 0.98,
        name: "年代不明瓷器",
        compliance_flags: ["疑似受监管文物"],
      },
      categories,
    );

    assert.equal(result.category_code, "compliance_review");
    assert.equal(result.status, "fallback");
  });

  test("normalizes sparse or invalid model output into a complete safe result", () => {
    const result = normalizeProductRecognition(
      { category_code: "invented_by_model", name: "  " },
      categories,
    );

    assert.equal(result.category_code, "ai_low_confidence");
    assert.equal(result.name, "未命名中古商品");
    assert.deepEqual(result.attributes.material, []);
    assert.deepEqual(result.keywords, []);
    assert.deepEqual(result.evidence, []);
  });

  test("normalizes facets, brand matching, and per-field confidence without inventing records", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "porcelain_europe",
        confidence: 0.95,
        name: "Wedgwood 描金骨瓷杯",
        attributes: { brand: "韦奇伍德", origin_country: "英国", material: ["骨瓷"] },
        facet_predictions: [
          { dimension: "origin", value: "UK", confidence: 0.91 },
          { dimension: "material", value: "Bone China", confidence: 0.96 },
          { dimension: "craft", value: "金彩", confidence: 0.77 },
          { dimension: "style", value: "AI 自创风格", confidence: 0.66 },
        ],
        attribute_confidence: { brand: 0.93, era: 1.5, material: -0.2 },
        clarification_requests: [
          { field: "era", question: "请补拍底款", reason: "当前图片无法确认年代" },
        ],
      },
      categories,
      { facets, brands, ips: [] },
    );

    assert.equal(result.brand_id, "brand-wedgwood");
    assert.equal(result.brand_candidate_text, "韦奇伍德");
    assert.equal(result.brand_match_status, "matched");
    assert.deepEqual(
      result.facets.map((item) => item.code),
      ["origin_uk", "material_bone_china", "craft_gilt"],
    );
    assert.equal(result.unmatched_facets[0]?.value, "AI 自创风格");
    assert.deepEqual(result.attribute_confidence, { brand: 0.93, era: 1, material: 0 });
    assert.equal(result.clarification_requests[0]?.field, "era");
  });

  test("keeps an unknown brand as a review candidate", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.9,
        attributes: { brand: "Unknown Toy Works" },
      },
      categories,
      { facets, brands, ips: [] },
    );

    assert.equal(result.brand_id, null);
    assert.equal(result.brand_candidate_text, "Unknown Toy Works");
    assert.equal(result.brand_match_status, "review_required");
  });

  test("matches an IP independently from the product brand", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.94,
        name: "Hello Kitty 陶瓷摆件",
        attributes: { brand: "Sanrio" },
        ip_name: "凯蒂猫",
      },
      categories,
      { facets, brands, ips },
    );

    assert.equal(result.ip_id, "ip-hello-kitty");
    assert.equal(result.ip_name, "Hello Kitty");
    assert.equal(result.ip_match_status, "matched");
    assert.equal(result.brand_id, null);
  });

  test("keeps an unknown IP as a review candidate instead of inventing an active record", () => {
    const result = normalizeProductRecognition(
      {
        category_code: "toy_character_figure",
        confidence: 0.91,
        name: "未知角色挂件",
        ip_name: "Moon Bunny",
      },
      categories,
      { facets, brands, ips },
    );

    assert.equal(result.ip_id, null);
    assert.equal(result.ip_name, "Moon Bunny");
    assert.equal(result.ip_match_status, "review_required");
    assert.deepEqual(result.ip_suggestions, []);
  });
});
