import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const ParcelExtractSchema = z.object({
  source_order_no: z.string().nullable().optional(),
  tracking_no: z.string().nullable().optional(),
  item_title: z.string().nullable().optional(),
  item_title_cn: z.string().nullable().optional(),
  seller: z.string().nullable().optional(),
  price_jpy: z.number().nullable().optional(),
  service_fee_jpy: z.number().nullable().optional(),
  domestic_freight_jpy: z.number().nullable().optional(),
  intl_freight_jpy: z.number().nullable().optional(),
  total_jpy: z.number().nullable().optional(),
  warehouse_location: z.string().nullable().optional(),
  weight_g: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const recognizeParcelScreenshot = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        image_base64: z.string().min(1), // data URL or raw base64
        mime_type: z.string().default("image/png"),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const gateway = createOpenAICompatible({
      name: "lovable",
      baseURL: "https://ai.gateway.lovable.dev/v1",
      headers: {
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
    });
    const model = gateway("google/gemini-3-flash-preview");

    const dataUrl = data.image_base64.startsWith("data:")
      ? data.image_base64
      : `data:${data.mime_type};base64,${data.image_base64}`;

    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: ParcelExtractSchema }),
        messages: [
          {
            role: "system",
            content:
              "你是一个日本代购订单截图识别助手。请从图片中提取订单字段，返回 JSON。所有金额为日元数字（不含货币符号），中文标题填 item_title_cn，原始日文填 item_title。无法识别的字段返回 null。",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "请识别这张订单截图中的字段。" },
              { type: "image", image: dataUrl },
            ],
          },
        ],
      });
      return { ok: true, fields: output };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, reason: msg };
    }
  });

const ItemSchema = z.object({
  sub_order_no: z.string().nullable().optional(),
  item_title: z.string().nullable().optional(),
  item_title_cn: z.string().nullable().optional(),
  item_image_url: z.string().nullable().optional(),
  unit_price_jpy: z.number().nullable().optional(),
  quantity: z.number().nullable().optional(),
  item_total_jpy: z.number().nullable().optional(),
  item_total_cny: z.number().nullable().optional(),
  service_fee_jpy: z.number().nullable().optional(),
  domestic_freight_jpy: z.number().nullable().optional(),
  freight_diff_jpy: z.number().nullable().optional(),
  weight_g: z.number().nullable().optional(),
  exchange_rate: z.number().nullable().optional(),
  pay_method: z.string().nullable().optional(),
  pay_at: z.string().nullable().optional(),
  merchant_order_no: z.string().nullable().optional(),
});

const ParcelBlockSchema = z.object({
  parcel: z
    .object({
      source_order_no: z.string().nullable().optional(),
      tracking_no: z.string().nullable().optional(),
      status_text: z.string().nullable().optional(),
      total_weight_g: z.number().nullable().optional(),
      volume_cm3: z.number().nullable().optional(),
      max_side_cm: z.number().nullable().optional(),
      storage_days: z.number().nullable().optional(),
      receiver_name: z.string().nullable().optional(),
      receiver_phone: z.string().nullable().optional(),
      receiver_address: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  intl_fee: z
    .object({
      intl_total_jpy: z.number().nullable().optional(),
      intl_total_cny: z.number().nullable().optional(),
      intl_pay_method: z.string().nullable().optional(),
      intl_pay_at: z.string().nullable().optional(),
      intl_merchant_order_no: z.string().nullable().optional(),
      intl_exchange_rate: z.number().nullable().optional(),
      intl_freight_jpy: z.number().nullable().optional(),
      intl_ship_method: z.string().nullable().optional(),
      intl_charge_method: z.string().nullable().optional(),
      intl_keep_packaging_jpy: z.number().nullable().optional(),
      intl_reinforce_jpy: z.number().nullable().optional(),
      intl_send_fee_jpy: z.number().nullable().optional(),
      intl_photo_fee_jpy: z.number().nullable().optional(),
      intl_merge_fee_jpy: z.number().nullable().optional(),
      intl_points_used: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  items: z.array(ItemSchema).default([]),
});

const SYSTEM_BLOCK = `你是日本代购包裹订单识别助手。从输入（文字或截图）中提取一个"合单大包裹"的完整字段，输出 JSON：
- parcel: 订单/收货/重量体积等基础信息
- intl_fee: 国际物流费用明细（intl_ 前缀）
- items: 数组，每个元素是一个子订单（即包裹中的单件商品）
所有金额以日元数字给出（不含货币符号），中文标题填到 item_title_cn，原始日文填 item_title。
日期时间用 ISO8601。无法识别的字段返回 null。子订单一定要尽量解析全。`;

export const recognizeParcelBlock = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        text: z.string().max(20000).optional(),
        image_base64: z.string().optional(),
        mime_type: z.string().default("image/png"),
      })
      .refine((d) => !!d.text || !!d.image_base64, { message: "text 或 image_base64 至少一个" })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");
    const gateway = createOpenAICompatible({
      name: "lovable",
      baseURL: "https://ai.gateway.lovable.dev/v1",
      headers: {
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
    });
    const model = gateway("google/gemini-3-flash-preview");

    const userContent: Array<
      { type: "text"; text: string } | { type: "image"; image: string }
    > = [];
    if (data.text) userContent.push({ type: "text", text: data.text });
    if (data.image_base64) {
      const dataUrl = data.image_base64.startsWith("data:")
        ? data.image_base64
        : `data:${data.mime_type};base64,${data.image_base64}`;
      userContent.push({ type: "text", text: "请识别这张/这些截图中的包裹与子订单。" });
      userContent.push({ type: "image", image: dataUrl });
    }

    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: ParcelBlockSchema }),
        messages: [
          { role: "system", content: SYSTEM_BLOCK },
          { role: "user", content: userContent },
        ],
      });
      return { ok: true as const, data: output };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message };
    }
  });

// ============================================================
// 中古杂货 SKU 智能识别：从多张照片识别 类目 / 品名 / 描述 / 评级
// ============================================================

const SkuRecognizeSchema = z.object({
  category: z
    .enum([
      "jp_porcelain",
      "eu_porcelain",
      "vintage_toy",
      "anime_goods",
      "media",
      "digital",
      "jewelry",
      "fashion",
      "daily",
      "antique",
    ])
    .nullable()
    .optional(),
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  grade: z.enum(["N", "S", "A", "B", "C", "J"]).nullable().optional(),
});

const SKU_RECOGNIZE_SYSTEM = `你是中古杂货商品识别助手。根据用户拍摄的若干张商品照片，输出 JSON：
- category：从以下枚举里选一个，选不准就 null：
  jp_porcelain 日本瓷器 / eu_porcelain 欧洲瓷器 / vintage_toy 中古玩具 / anime_goods 二次元周边 /
  media 音像制品 / digital 数码家电 / jewelry 珠宝首饰 / fashion 时尚配件 / daily 日用杂货 / antique 古美术
- name：6-20 字简洁中文品名，能体现品类/材质/特征，例如"日本九谷烧花鸟纹盖碗"。
- description：80 字以内中文卖点描述，突出年代感/工艺/品相/适用场景，便于挂网店。不要写"图中所示""根据照片"之类。
- grade：观察外观判断成色档：
  N 全新未拆 / S 已拆封但完好 / A 轻微痕迹 / B 明显痕迹或轻微缺陷 / C 严重瑕疵但能用 / J 残缺当垃圾。
拿不准的字段返回 null，不要瞎编。`;

export const recognizeSkuFromPhotos = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        images: z
          .array(
            z.object({
              base64: z.string().min(1),
              mime: z.string().default("image/jpeg"),
            }),
          )
          .min(1)
          .max(8),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");
    const gateway = createOpenAICompatible({
      name: "lovable",
      baseURL: "https://ai.gateway.lovable.dev/v1",
      headers: {
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
    });
    const model = gateway("google/gemini-3-flash-preview");

    const userContent: Array<
      { type: "text"; text: string } | { type: "image"; image: string }
    > = [{ type: "text", text: `请识别以下 ${data.images.length} 张商品照片。` }];
    for (const img of data.images) {
      const url = img.base64.startsWith("data:")
        ? img.base64
        : `data:${img.mime};base64,${img.base64}`;
      userContent.push({ type: "image", image: url });
    }

    try {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: SkuRecognizeSchema }),
        messages: [
          { role: "system", content: SKU_RECOGNIZE_SYSTEM },
          { role: "user", content: userContent },
        ],
      });
      return {
        ok: true as const,
        fields: {
          category: output.category ?? "",
          name: output.name ?? "",
          description: output.description ?? "",
          grade: output.grade ?? "",
        },
      };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message };
    }
  });
