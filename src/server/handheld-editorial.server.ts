import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getPublicOrigin, resolvePublicSkuImageUrls } from "@/lib/sku-media";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-3.6-flash";

function slugify(name: string, skuId: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "item"}-${skuId.slice(0, 8)}`;
}

export type GenerateEditorialResult = {
  content_id: string;
  slug: string;
  status: "draft" | "pending_review" | "published";
  title: string;
  summary: string;
  cover_url: string | null;
  related_sku_id: string;
  reused: boolean;
};

/**
 * 根据一个自定义商品（SKU）的识别结果 + 多图，生成 1 篇达人文案并挂到「发现」。
 * 幂等：同一 sku 只会有一篇（slug 唯一），重复调用返回已有内容。
 */
export async function generateEditorialForSku(args: {
  skuId: string;
  publish: boolean;
}): Promise<GenerateEditorialResult> {
  const { data: sku, error } = await supabaseAdmin
    .from("inv_skus")
    .select(
      "id, name, category, grade, notes, price_tier, is_custom_price, inventory_policy, attributes, image_url, image_paths",
    )
    .eq("id", args.skuId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!sku) throw new Error("SKU 不存在");

  const row = sku as unknown as {
    id: string;
    name: string;
    category: string | null;
    grade: string | null;
    notes: string | null;
    price_tier: number | null;
    is_custom_price: boolean | null;
    inventory_policy: string | null;
    attributes: Record<string, unknown> | null;
    image_url: string | null;
    image_paths: string[] | null;
  };
  if (row.is_custom_price !== true || row.inventory_policy === "unlimited") {
    throw new Error("只有自定义（唯一件）商品才生成达人文案");
  }

  const slug = slugify(row.name, row.id);
  const { data: existing } = await supabaseAdmin
    .from("editorial_contents")
    .select("id, slug, status, title, summary, cover_url")
    .eq("slug", slug)
    .maybeSingle();
  if (existing) {
    const e = existing as unknown as {
      id: string;
      slug: string;
      status: GenerateEditorialResult["status"];
      title: string;
      summary: string;
      cover_url: string | null;
    };
    const { id, ...rest } = e;
    return { content_id: id, ...rest, related_sku_id: row.id, reused: true };
  }

  const origin = getPublicOrigin();
  const images = resolvePublicSkuImageUrls(
    [row.image_url, ...(Array.isArray(row.image_paths) ? row.image_paths : [])],
    origin,
    4,
  );

  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("LOVABLE_API_KEY not configured");

  const prompt = [
    "你是 BOOMER OFF vintage 的中古买手主理人，为一件孤品写一篇「发现」种草短文。",
    "要求：真实克制，不夸大成色，不编造品牌年代；只依据给出的信息和图片。",
    '严格输出 JSON：{"title":"<=24字","summary":"<=60字","body":"200-400字，可用换行分段","keywords":["3-6个中文关键词"]}',
    "",
    `商品名：${row.name}`,
    `类目：${row.category ?? "未知"}`,
    `成色：${row.grade ?? "未标注"}`,
    `售价：¥${row.price_tier ?? "-"}`,
    `备注：${row.notes ?? "无"}`,
    `识别属性：${JSON.stringify(row.attributes ?? {}).slice(0, 1200)}`,
  ].join("\n");

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const url of images) content.push({ type: "image_url", image_url: { url } });

  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new Error(`AI 文案生成失败：HTTP ${res.status} ${(await res.text()).slice(0, 240)}`);
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = payload.choices?.[0]?.message?.content ?? "{}";
  let parsed: { title?: string; summary?: string; body?: string; keywords?: string[] };
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ""));
  } catch {
    throw new Error("AI 返回不是合法 JSON");
  }
  const title = (parsed.title ?? row.name).trim().slice(0, 60);
  const summary = (parsed.summary ?? row.name).trim().slice(0, 200);
  const body = (parsed.body ?? "").trim();
  if (!body) throw new Error("AI 未生成正文");

  const status: GenerateEditorialResult["status"] = args.publish ? "published" : "pending_review";
  const nowIso = new Date().toISOString();
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("editorial_contents")
    .insert({
      slug,
      type: "article",
      status,
      title,
      summary,
      body,
      cover_url: images[0] ?? null,
      keywords: (parsed.keywords ?? []).slice(0, 6),
      related_product_ids: [row.id],
      source: { generator: "handheld.content.generate-from-sku", model: MODEL, sku_id: row.id },
      published_at: status === "published" ? nowIso : null,
    } as never)
    .select("id, slug, status, title, summary, cover_url")
    .single();
  if (insertError || !inserted) {
    throw new Error(insertError?.message ?? "写入发现内容失败");
  }
  const created = inserted as unknown as {
    id: string;
    slug: string;
    status: GenerateEditorialResult["status"];
    title: string;
    summary: string;
    cover_url: string | null;
  };

  const { error: relError } = await supabaseAdmin.from("editorial_content_relations").upsert(
    {
      content_id: created.id,
      entity_type: "product",
      entity_key: row.id,
      label: row.name,
    } as never,
    { onConflict: "content_id,entity_type,entity_key" },
  );
  if (relError) throw new Error(relError.message);

  const { id: createdId, ...createdRest } = created;
  return { content_id: createdId, ...createdRest, related_sku_id: row.id, reused: false };
}
