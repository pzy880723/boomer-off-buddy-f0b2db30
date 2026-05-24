import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BUCKET = "parcel-item-images";

/** AI 生成商品图（Lovable AI / Nano Banana） */
export const generateSkuImage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ prompt: z.string().min(2).max(500) }).parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY is not configured");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: data.prompt }],
        modalities: ["image", "text"],
      }),
    });
    if (res.status === 429) throw new Error("AI 调用过于频繁，请稍后重试");
    if (res.status === 402) throw new Error("AI 额度不足，请到 Workspace 充值");
    if (!res.ok) throw new Error(`AI 生成失败 (${res.status})`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    };
    const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!url) throw new Error("AI 未返回图片");
    return { dataUrl: url };
  });

/** Firecrawl 在线图片搜索 */
export const searchSkuImages = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ query: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.FIRECRAWL_API_KEY;
    if (!key) throw new Error("未配置 Firecrawl，请在 Connectors 中启用");

    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: data.query,
        sources: ["images"],
        limit: 18,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Firecrawl 搜索失败 (${res.status}): ${t.slice(0, 120)}`);
    }
    const json = (await res.json()) as {
      data?: { images?: Array<{ url?: string; imageUrl?: string; title?: string }> };
    };
    const raw = json.data?.images ?? [];
    const images = raw
      .map((it) => ({
        url: it.imageUrl || it.url || "",
        title: it.title || "",
      }))
      .filter((it) => it.url.startsWith("http"));
    return { images };
  });

/** 把外链图片或 data URL 保存到对象存储，返回公共 URL */
export const saveImageFromUrl = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ url: z.string().min(8).max(2_000_000) }).parse(input),
  )
  .handler(async ({ data }) => {
    let blob: ArrayBuffer;
    let mime = "image/jpeg";
    let ext = "jpg";

    if (data.url.startsWith("data:")) {
      const m = data.url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error("非法 data URL");
      mime = m[1];
      ext = mime.split("/")[1] || "png";
      const bin = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
      blob = bin.buffer;
    } else {
      const res = await fetch(data.url);
      if (!res.ok) throw new Error(`下载图片失败 (${res.status})`);
      mime = res.headers.get("content-type") || "image/jpeg";
      ext = (mime.split("/")[1] || "jpg").split(";")[0];
      blob = await res.arrayBuffer();
      if (blob.byteLength > 8 * 1024 * 1024) throw new Error("图片过大 (>8MB)");
    }

    const path = `skus/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, blob, {
      contentType: mime,
      cacheControl: "3600",
      upsert: false,
    });
    if (error) throw new Error(error.message);
    const { data: pub } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
    return { imageUrl: pub.publicUrl };
  });
