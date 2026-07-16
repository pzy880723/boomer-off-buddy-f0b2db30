import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

    const userContent: Array<{ type: "text"; text: string } | { type: "image"; image: string }> =
      [];
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

export const recognizeSkuFromPhotos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
  .handler(async ({ data, context }) => {
    try {
      const { recognizeProductFromImages } = await import("@/server/product-recognition.server");
      const fields = await recognizeProductFromImages({
        images: data.images.map((image) =>
          image.base64.startsWith("data:")
            ? image.base64
            : `data:${image.mime};base64,${image.base64}`,
        ),
        source: "erp",
        created_by: context.userId,
      });
      return { ok: true as const, fields };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message };
    }
  });
