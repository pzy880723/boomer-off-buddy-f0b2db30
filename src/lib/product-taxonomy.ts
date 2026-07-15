export const FACET_DIMENSIONS = [
  "object_type",
  "function",
  "origin",
  "material",
  "era",
  "craft",
  "style",
  "ip",
  "character",
  "series",
  "release_method",
] as const;

export type FacetDimension = (typeof FACET_DIMENSIONS)[number];

export type FacetTerm = {
  code: string;
  name: string;
  dimension: FacetDimension;
  aliases: string[];
};

export type FacetPrediction = {
  dimension: string;
  value: string;
  confidence?: number | null;
};

export type NormalizedFacetMatch = {
  code: string;
  name: string;
  dimension: FacetDimension;
  confidence: number | null;
};

export type BrandCandidate = {
  id: string;
  name: string;
  name_original: string | null;
  aliases: string[];
};

export type BrandMatchResult = {
  match: BrandCandidate | null;
  candidate_text: string | null;
  status: "empty" | "matched" | "review_required";
  suggestions: Array<{ brand: BrandCandidate; score: number }>;
};

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeLookupText(value: unknown): string {
  return cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function cleanConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function trigrams(value: string): Set<string> {
  const normalized = `  ${normalizeLookupText(value)} `;
  const output = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    output.add(normalized.slice(index, index + 3));
  }
  return output;
}

function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  return (2 * intersection) / (a.size + b.size);
}

export function buildBrandSearchText(brand: BrandCandidate): string {
  return [brand.name, brand.name_original, ...brand.aliases]
    .map(cleanText)
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function matchBrandCandidate(value: unknown, brands: BrandCandidate[]): BrandMatchResult {
  const candidateText = cleanText(value);
  const normalized = normalizeLookupText(candidateText);
  if (!normalized) {
    return { match: null, candidate_text: null, status: "empty", suggestions: [] };
  }

  const exact = brands.find((brand) =>
    [brand.name, brand.name_original, ...brand.aliases]
      .map(normalizeLookupText)
      .some((name) => name === normalized),
  );
  if (exact) {
    return { match: exact, candidate_text: candidateText, status: "matched", suggestions: [] };
  }

  const suggestions = brands
    .map((brand) => ({
      brand,
      score: Math.max(
        ...[brand.name, brand.name_original, ...brand.aliases]
          .filter((name): name is string => !!name)
          .map((name) => trigramSimilarity(candidateText, name)),
      ),
    }))
    .filter((item) => item.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    match: null,
    candidate_text: candidateText,
    status: "review_required",
    suggestions,
  };
}

export function normalizeFacetPredictions(
  predictions: FacetPrediction[],
  terms: FacetTerm[],
): { matches: NormalizedFacetMatch[]; unmatched: FacetPrediction[] } {
  const dimensions = new Set<string>(FACET_DIMENSIONS);
  const indexes = new Map<string, FacetTerm>();
  for (const term of terms) {
    for (const label of [term.code, term.name, ...term.aliases]) {
      indexes.set(`${term.dimension}:${normalizeLookupText(label)}`, term);
    }
  }

  const matches = new Map<string, NormalizedFacetMatch>();
  const unmatched: FacetPrediction[] = [];
  for (const prediction of predictions) {
    const dimension = cleanText(prediction.dimension);
    const value = cleanText(prediction.value);
    const confidence = cleanConfidence(prediction.confidence);
    if (!dimensions.has(dimension) || !value) {
      if (value) unmatched.push({ dimension, value, confidence });
      continue;
    }
    const term = indexes.get(`${dimension}:${normalizeLookupText(value)}`);
    if (!term) {
      unmatched.push({ dimension, value, confidence });
      continue;
    }
    const existing = matches.get(term.code);
    if (!existing || (confidence ?? -1) > (existing.confidence ?? -1)) {
      matches.set(term.code, {
        code: term.code,
        name: term.name,
        dimension: term.dimension,
        confidence,
      });
    }
  }

  return { matches: [...matches.values()], unmatched };
}
