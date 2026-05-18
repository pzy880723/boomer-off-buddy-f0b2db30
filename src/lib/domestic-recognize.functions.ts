import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { PLATFORMS, STATUSES } from "./domestic-orders.functions";

function getModel(name = "google/gemini-2.5-pro") {
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
  return gateway(name);
}

// ---------- 后处理 ----------
const stripNum = (v: unknown): number | null => {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s¥￥元RMB]/gi, "");
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const toIsoCn = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
  const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0"] = m;
  const pad = (x: string) => x.padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+08:00`;
};

const cleanPhone = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\D/g, "");
  return s.length >= 7 ? s : null;
};

const OrderSchema = z.object({
  platform: z.enum(PLATFORMS).nullable().optional(),
  source_order_no: z.string().nullable().optional(),
  seller_name: z.string().nullable().optional(),
  seller_handle: z.string().nullable().optional(),
  item_title: z.string().nullable().optional(),
  item_image_url: z.string().nullable().optional(),
  qty: z.number().nullable().optional(),
  price_cny: z.number().nullable().optional(),
  shipping_cny: z.number().nullable().optional(),
  total_cny: z.number().nullable().optional(),
  purchased_at: z.string().nullable().optional(),
  tracking_no: z.string().nullable().optional(),
  carrier: z.string().nullable().optional(),
  receiver_name: z.string().nullable().optional(),
  receiver_phone: z.string().nullable().optional(),
  receiver_address: z.string().nullable().optional(),
  status: z.enum(STATUSES).nullable().optional(),
  chat_summary: z.string().nullable().optional(),
});

const BatchSchema = z.object({
  orders: z.array(OrderSchema),
});

const SYSTEM_PROMPT = `你是中国电商订单截图解析器。用户会一次性上传 1~N 张截图，可能来自：
  - 闲鱼(xianyu)：橙黄色，"已付款/已发货/已确认收货"
  - 抖音/抖店(douyin)：黑色 + 玫红，"待发货/已发货/已签收"
  - 小红书(xiaohongshu)：玫红/白底，"待发货/已发货"
  - 微信(wechat)：私聊截图气泡，蓝绿气泡，**没有平台订单号**
  - 拼多多(pinduoduo)：红色

【输出】严格 JSON：{ "orders": [ {订单1}, {订单2}, ... ] }。每张截图通常对应 1 个订单；多个订单同图就拆成多条。

【字段】
  platform:        必填，五选一字符串
  source_order_no: 平台订单号；微信聊天没有就生成 "WX-YYYYMMDD-XXXX"（XXXX 为聊天里能识别到的金额/姓氏拼音 4 位）
  seller_name:     卖家显示名 / 店铺名 / 对话方昵称
  seller_handle:   卖家 @handle（闲鱼/小红书 等）
  item_title:      商品标题（微信聊天就把交易物品名提炼一句）
  item_image_url:  截图中商品主图的可见 URL（基本拿不到，留 null）
  qty:             数量，默认 1
  price_cny:       商品单价 ¥
  shipping_cny:    运费 ¥
  total_cny:       实付总金额 ¥（最重要，必填）
  purchased_at:    下单时间，转成 ISO8601 +08:00；只看到日期就 "YYYY-MM-DDT00:00:00+08:00"
  tracking_no:     物流单号
  carrier:         快递公司名（顺丰/中通/圆通/韵达/京东/邮政...）
  receiver_name/phone/address: 收货信息（截图里有才填）
  status:          pending_pay | paid | shipped | delivered | completed
                     待付款→pending_pay, 已付款/待发货→paid, 已发货→shipped, 已签收/已收货→delivered, 已完成/确认收货→completed
  chat_summary:    仅微信用：1~2 句话概括聊天内容（聊了什么、约定了什么、风险点）

【金额】纯数字，去 ¥/￥/逗号
【没有的字段一律返回 null，不要瞎猜】
【如果同一商品在多张截图里出现（订单详情 + 物流页 + 聊天页），合并成一条订单】`;

export const recognizeDomesticScreenshots = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        images: z
          .array(
            z.object({
              image_base64: z.string().min(1),
              mime_type: z.string().default("image/png"),
            }),
          )
          .min(1)
          .max(15),
        hint_platform: z.enum(PLATFORMS).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const userParts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
      {
        type: "text",
        text:
          (data.hint_platform
            ? `用户已经选择了平台：${data.hint_platform}。请所有订单的 platform 都填这个值。\n`
            : "请自行识别每张截图属于哪个平台。\n") +
          `共 ${data.images.length} 张截图，请合并解析成订单数组。`,
      },
    ];
    for (const img of data.images) {
      const dataUrl = img.image_base64.startsWith("data:")
        ? img.image_base64
        : `data:${img.mime_type};base64,${img.image_base64}`;
      userParts.push({ type: "image", image: dataUrl });
    }

    try {
      const { output } = await generateText({
        model: getModel("google/gemini-2.5-pro"),
        output: Output.object({ schema: BatchSchema }),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userParts },
        ],
      });
      const raw = output as z.infer<typeof BatchSchema>;
      const orders = (raw.orders ?? []).map((o) => {
        const platform = (data.hint_platform ?? o.platform ?? "xianyu") as (typeof PLATFORMS)[number];
        return {
          ...o,
          platform,
          qty: stripNum(o.qty) ?? 1,
          price_cny: stripNum(o.price_cny),
          shipping_cny: stripNum(o.shipping_cny),
          total_cny: stripNum(o.total_cny),
          purchased_at: toIsoCn(o.purchased_at),
          receiver_phone: cleanPhone(o.receiver_phone),
          status: o.status ?? "paid",
        };
      });
      return { ok: true as const, orders };
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message, orders: [] };
    }
  });
