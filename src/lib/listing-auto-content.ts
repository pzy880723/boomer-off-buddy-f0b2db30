import { facetDimensionLabel } from "./attribute-labels.ts";
import { ProductContentBlock, ProductContentBlocks } from "./product-content.ts";

/**
 * 零 AI 自动图文详情：只用本 SKU 已确认事实与本 SKU 自己的图片，
 * 外加有据（evidence 非空）且已发布的品牌/品类官方资料。未知即跳过，绝不补写年份/历史。
 */
export type AutoContentKnowledge = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  story: string | null;
  evidence: string[];
  updated_at: string;
};

export type AutoContentInput = {
  sku_id: string;
  name: string;
  category_name: string | null;
  brand: { name: string; name_original: string | null } | null;
  grade: string | null;
  facets: Array<{ dimension: string; name: string }>;
  image_paths: string[];
  knowledge: AutoContentKnowledge[];
};

export type AutoContentSource =
  | { kind: "sku_facts"; sku_id: string }
  | { kind: "official_knowledge"; id: string; type: string; title: string; version: string };

const GRADE_LABELS: Record<string, string> = {
  N: "全新未使用",
  S: "近乎全新",
  A: "使用痕迹轻微",
  B: "有明显使用痕迹",
  C: "有较多使用痕迹",
  J: "有瑕疵，详见细节图",
};

const IMAGE_PATH = /^sku-(?:raw|listing)\/[A-Za-z0-9_./-]+$/;

function clean(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[<>]/g, "")
    .replace(/(?:https?:\/\/|data:|javascript:)\S*/gi, "")
    .trim()
    .slice(0, 4000);
}

function validBlock(block: ProductContentBlock): boolean {
  return ProductContentBlock.safeParse(block).success;
}

export function buildAutoProductContent(input: AutoContentInput): {
  blocks: ProductContentBlock[];
  sources: AutoContentSource[];
} {
  const images = [...new Set(input.image_paths)].filter(
    (path) => IMAGE_PATH.test(path) && path.split("/").every((p) => p && p !== "." && p !== ".."),
  );
  const blocks: ProductContentBlock[] = [];
  const sources: AutoContentSource[] = [{ kind: "sku_facts", sku_id: input.sku_id }];
  const push = (block: ProductContentBlock) => {
    if (validBlock(block)) blocks.push(block);
  };

  if (images[0]) push({ id: "auto-cover", type: "image", storage_path: images[0] });
  push({ id: "auto-title", type: "heading", text: clean(input.name) || "商品介绍" });

  const traits = input.facets
    .filter((f) => ["material", "craft", "origin", "style", "era"].includes(f.dimension))
    .map((f) => clean(f.name))
    .filter(Boolean)
    .slice(0, 4);
  const brandName = clean(input.brand?.name);
  const grade = input.grade ? GRADE_LABELS[input.grade] : undefined;
  const reason = [
    brandName ? `出自${brandName}` : null,
    input.category_name ? `属于${clean(input.category_name)}` : null,
    traits.length ? `特点：${traits.join("、")}` : null,
    grade ? `品相：${grade}` : null,
  ].filter(Boolean);
  if (reason.length) {
    push({ id: "auto-reason", type: "heading", text: "推荐理由" });
    push({ id: "auto-reason-text", type: "paragraph", text: `${reason.join("；")}。` });
  }

  const facts = [
    input.category_name ? `品类：${clean(input.category_name)}` : null,
    brandName
      ? `品牌：${brandName}${input.brand?.name_original ? `（${clean(input.brand.name_original)}）` : ""}`
      : null,
    ...input.facets.flatMap((f) => {
      const label = facetDimensionLabel(f.dimension);
      const value = clean(f.name);
      return label && value ? [`${label}：${value}`] : [];
    }),
    grade ? `品相：${grade}` : null,
  ].filter(Boolean);
  if (facts.length) push({ id: "auto-facts", type: "facts", text: facts.join("\n") });

  if (images.length > 1) {
    push({ id: "auto-detail", type: "heading", text: "细节与品相" });
    images.slice(1, 9).forEach((path, i) => push({ id: `auto-detail-${i + 1}`, type: "image", storage_path: path }));
  }

  for (const entry of input.knowledge) {
    if (!entry.evidence.some((e) => e.trim())) continue; // 无来源不得使用
    const summary = clean(entry.summary);
    const story = clean(entry.story);
    const used: boolean[] = [];
    if (summary) {
      const title = entry.type === "brand" ? "品牌介绍" : clean(entry.title) || "相关介绍";
      const before = blocks.length;
      push({ id: `kn-${entry.id}-h`, type: "heading", text: title });
      push({ id: `kn-${entry.id}-s`, type: "paragraph", text: summary });
      used.push(blocks.length > before);
    }
    if (story) {
      const before = blocks.length;
      push({ id: `kn-${entry.id}-story-h`, type: "heading", text: "历史故事" });
      push({ id: `kn-${entry.id}-story`, type: "paragraph", text: story });
      used.push(blocks.length > before);
    }
    if (used.some(Boolean)) {
      sources.push({ kind: "official_knowledge", id: entry.id, type: entry.type, title: clean(entry.title), version: entry.updated_at });
    }
  }
  return { blocks: ProductContentBlocks.parse(blocks), sources };
}
