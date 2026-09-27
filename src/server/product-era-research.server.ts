import { randomUUID } from "node:crypto";

export type ReleaseFactBlock = { id: string; type: "facts"; text: string };

// Deliberately small: unsupported makers are skipped, never assigned a guessed official domain.
const MAKERS = [{ aliases: ["sony", "索尼"], name: "Sony", host: "www.sony.com" }];
const MODEL = /\b[A-Z][A-Z0-9]{1,11}-[A-Z0-9]{1,12}\b/gi;
const UNSAFE_TEXT = /[<>\u0000-\u001f\u007f]|https?:\/\/|data:|javascript:/i;
const AMBIGUOUS =
  /copyright|©|trademark|character|\b(?:not|never|may|might|possibly|rumou?red|estimated|reissue|replica|incorrect|false|untrue|mistaken)\b|ignore|instructions|prompt|版权|复刻|再版|可能|据说|指令/i;

function officialUrl(value: unknown, host: string): URL | null {
  if (typeof value !== "string" || value.length > 600) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9/_.,-]*$/.test(url.pathname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function releaseExcerpts(
  markdown: string,
  model: string,
): Array<{ excerpt: string; year: number }> {
  const escapedModel = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const month =
    "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
  const date = `(?:in\\s+|on\\s+${month}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+)((?:18|19|20)\\d{2})`;
  const release = new RegExp(
    `^(?:The\\s+(?:first\\s+)?model,?\\s+)?['"‘“]?${escapedModel}(?![A-Z0-9-])['"’”]?,?\\s+(?:was\\s+)?(?:first\\s+)?(?:introduced|released|launched)\\s+${date}(?:\\s+in\\s+(?:the\\s+)?[A-Za-z ]{2,60})?[.!]?$`,
    "i",
  );
  const results: Array<{ excerpt: string; year: number }> = [];
  // Preserve a complete literal sentence from the fetched body, not a model-generated paraphrase.
  for (const part of markdown.slice(0, 80_000).split(/\n|(?<=[.!?。！？])\s+/)) {
    const excerpt = part.trim();
    if (!excerpt || excerpt.length > 400 || UNSAFE_TEXT.test(excerpt) || AMBIGUOUS.test(excerpt))
      continue;
    const models = [...new Set((excerpt.match(MODEL) ?? []).map((v) => v.toUpperCase()))];
    if (models.length !== 1 || models[0] !== model) continue;
    const match = release.exec(excerpt);
    const years = [...new Set(excerpt.match(/\b(?:18|19|20)\d{2}\b/g) ?? [])];
    if (!match || years.length !== 1) continue;
    const year = Number(match[1]);
    if (year > new Date().getUTCFullYear()) continue;
    results.push({ excerpt, year });
  }
  return results;
}

/** Only called by authorized detail generation; no database writes and no LLM sees web content. */
export async function researchProductRelease(input: {
  name: string;
  brand: string | null;
}): Promise<ReleaseFactBlock[]> {
  const maker = MAKERS.find((entry) =>
    entry.aliases.includes(input.brand?.trim().toLowerCase() ?? ""),
  );
  const models = [
    ...new Set(
      (input.name.match(MODEL) ?? [])
        .filter((value) => /\d/.test(value))
        .map((value) => value.toUpperCase()),
    ),
  ];
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!maker || models.length !== 1 || !apiKey) return [];
  const model = models[0];
  try {
    const response = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `site:${maker.host.replace(/^www\./, "")} "${model}" introduced released launched`,
        sources: [{ type: "web" }],
        limit: 3,
        timeout: 7000,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
    });
    if (!response.ok) return [];
    const result = await response.json();
    if (result?.success !== true || !Array.isArray(result.data?.web)) return [];
    const evidence: Array<{ url: URL; excerpt: string; year: number }> = [];
    for (const page of result.data.web.slice(0, 3)) {
      const url = officialUrl(page?.url, maker.host);
      if (!url || typeof page.markdown !== "string") continue;
      if (page.metadata?.statusCode !== 200 || page.metadata?.sourceURL !== url.href) continue;
      if (
        page.metadata.url !== undefined &&
        officialUrl(page.metadata.url, maker.host)?.href !== url.href
      )
        continue;
      for (const found of releaseExcerpts(page.markdown, model)) evidence.push({ url, ...found });
    }
    if (!evidence.length || new Set(evidence.map((item) => item.year)).size !== 1) return [];
    const found = evidence[0];
    const text = `型号发布记录：${found.year}年（${maker.name}官方档案；不代表本件商品的生产年份）\n型号：${model}\n性质：官方型号发布记录（具体地区或范围以原文为准）\n来源（HTTPS）：${maker.host}${found.url.pathname}\n来源地址为不可点击的纯文本\n查证日期（UTC）：${new Date().toISOString().slice(0, 10)}\n官方正文摘录：${found.excerpt}`;
    return [{ id: randomUUID(), type: "facts", text }];
  } catch {
    // Optional enrichment: missing provider, timeout, invalid payload and no evidence are all a skip.
    return [];
  }
}
