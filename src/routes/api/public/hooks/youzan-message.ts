// 有赞消息推送回调 —— 接收订单成交/退款等事件，实时更新本地库存
// 有赞消息订阅文档：https://doc.youzanyun.com/detail/API/0/33
// 你需要到有赞云后台 → 消息订阅 → 填此 URL，勾选事件：
//   - TRADE_TradePaid（订单已付款）
//   - TRADE_TradeSuccess（订单已完成）
//   - REFUND_RefundSuccess（退款成功，需要回补库存）
//   - ITEM_Update（商品编辑，可选）
//
// 签名：有赞会在 body 里附带 sign 字段（MD5(client_id + msg + client_secret)）
// 我们收到后：
//   1. 验签
//   2. 按 kdt_id → youzan_shops.id 找到店铺
//   3. 从 msg.data.item_id → sku_youzan_links(sku_id, shop_id) → 找本地 SKU
//   4. inv_apply_movement 扣/加库存
//   5. 记 log 到 youzan_sync_logs
import { createFileRoute } from "@tanstack/react-router";
import { createHash } from "crypto";

type YZMessage = {
  id?: string;
  client_id?: string;
  kdt_id?: number;
  type?: string;
  mode?: string;
  msg?: string; // JSON string with event payload
  sign?: string;
  test?: string;
};

export const Route = createFileRoute("/api/public/hooks/youzan-message")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const contentType = request.headers.get("content-type") ?? "";
        let payload: YZMessage;
        try {
          if (contentType.includes("application/json")) {
            payload = (await request.json()) as YZMessage;
          } else {
            const text = await request.text();
            const params = new URLSearchParams(text);
            payload = Object.fromEntries(params.entries()) as YZMessage;
          }
        } catch (e) {
          return Response.json(
            { code: 400, message: `bad body: ${e instanceof Error ? e.message : String(e)}` },
            { status: 400 },
          );
        }

        // 有赞平台"验证订阅 URL"时会发一个 test=1 的空消息，回 { code:0, msg:"success" } 即可
        if (payload.test === "1" || payload.test === "true") {
          return Response.json({ code: 0, msg: "success" });
        }

        // ===== 验签 =====
        const clientId = process.env.YOUZAN_CLIENT_ID ?? "";
        const clientSecret = process.env.YOUZAN_CLIENT_SECRET ?? "";
        const expected = createHash("md5")
          .update(`${clientId}${payload.msg ?? ""}${clientSecret}`)
          .digest("hex");
        if (!payload.sign || payload.sign.toLowerCase() !== expected.toLowerCase()) {
          return Response.json({ code: 401, message: "invalid sign" }, { status: 401 });
        }

        // ===== 处理业务 =====
        let event: Record<string, unknown> = {};
        try {
          event = payload.msg ? (JSON.parse(payload.msg) as Record<string, unknown>) : {};
        } catch {
          /* keep empty */
        }

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

          // 记 log（成功/失败都记）
          await supabaseAdmin.from("youzan_sync_logs").insert({
            action: "message_push",
            status: "running",
            message: `type=${payload.type ?? "?"} kdt=${payload.kdt_id ?? "?"}`,
            raw: { payload, event } as never,
            kdt_id: payload.kdt_id ?? null,
          } as never);

          const type = String(payload.type ?? "");
          const kdtId = Number(payload.kdt_id ?? 0);

          // 找到本店 shop_id
          if (kdtId) {
            const { data: shop } = await supabaseAdmin
              .from("youzan_shops")
              .select("id")
              .eq("kdt_id", kdtId)
              .maybeSingle();
            if (shop) {
              const shopId = shop.id as string;
              // 交易成功事件 → 按订单里的 item_id/num 扣库存
              if (
                type === "TRADE_TradePaid" ||
                type === "TRADE_TradeSuccess" ||
                type === "TRADE_TradeMemoModified"
              ) {
                await handleTradeEvent(supabaseAdmin, shopId, event);
              }
              // 退款事件 → 加回库存
              if (type === "REFUND_RefundSuccess" || type === "REFUND_SellerAgree") {
                await handleRefundEvent(supabaseAdmin, shopId, event);
              }
            }
          }
        } catch (e) {
          // 内部错误也回 success 给有赞（避免它无限重试），日志已经记了
          console.error("[youzan-message]", e);
        }

        return Response.json({ code: 0, msg: "success" });
      },
    },
  },
});

type SB = Awaited<
  ReturnType<
    typeof import("@/integrations/supabase/client.server").supabaseAdmin.from
  >
>["constructor"] extends never ? never : never;

async function handleTradeEvent(sb: unknown, shopId: string, event: Record<string, unknown>) {
  const items = extractOrderItems(event);
  for (const it of items) {
    // 找 (shop, item_id) → sku_id
    const supa = sb as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (
            c: string,
            v: unknown,
          ) => { eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: { sku_id: string } | null }> } };
        };
        insert: (row: unknown) => Promise<unknown>;
      };
      rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    };
    const { data: link } = await supa
      .from("sku_youzan_links")
      .select("sku_id")
      .eq("shop_id", shopId)
      .eq("yz_item_id", it.item_id)
      .maybeSingle();
    if (!link) continue;
    // 找门店 location
    const locQuery = supa.from("inv_locations").select("id") as unknown as {
      eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: { id?: string } | null }> };
    };
    const { data: loc } = await locQuery.eq("shop_id", shopId).maybeSingle();
    const locationId = (loc as { id?: string } | null)?.id;
    if (!locationId) continue;
    await supa.rpc("inv_apply_movement", {
      p_sku_id: link.sku_id,
      p_location_id: locationId,
      p_delta: -Math.abs(it.qty),
      p_ref_type: "yz_trade",
      p_ref_id: null,
      p_epc: null,
      p_note: `有赞订单成交 item=${it.item_id} x${it.qty}`,
    });
  }
}

async function handleRefundEvent(sb: unknown, shopId: string, event: Record<string, unknown>) {
  const items = extractOrderItems(event);
  const supa = sb as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          c: string,
          v: unknown,
        ) => { eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: { sku_id: string } | null }> } };
      };
    };
    rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  for (const it of items) {
    const { data: link } = await supa
      .from("sku_youzan_links")
      .select("sku_id")
      .eq("shop_id", shopId)
      .eq("yz_item_id", it.item_id)
      .maybeSingle();
    if (!link) continue;
    const locQuery = supa.from("inv_locations").select("id") as unknown as {
      eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: { id?: string } | null }> };
    };
    const { data: loc } = await locQuery.eq("shop_id", shopId).maybeSingle();
    const locationId = (loc as { id?: string } | null)?.id;
    if (!locationId) continue;
    await supa.rpc("inv_apply_movement", {
      p_sku_id: link.sku_id,
      p_location_id: locationId,
      p_delta: Math.abs(it.qty),
      p_ref_type: "yz_refund",
      p_ref_id: null,
      p_epc: null,
      p_note: `有赞退款回补 item=${it.item_id} x${it.qty}`,
    });
  }
}

// 从有赞消息里挖出 order_items（不同事件字段结构略有差异）
function extractOrderItems(event: Record<string, unknown>): Array<{ item_id: number; qty: number }> {
  const out: Array<{ item_id: number; qty: number }> = [];
  const candidates = [
    event.orders,
    (event.trade as Record<string, unknown> | undefined)?.orders,
    (event.data as Record<string, unknown> | undefined)?.orders,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const row of c) {
        const r = row as { num_iid?: number; item_id?: number; num?: number; quantity?: number };
        const item_id = Number(r.num_iid ?? r.item_id ?? 0);
        const qty = Number(r.num ?? r.quantity ?? 0);
        if (item_id && qty) out.push({ item_id, qty });
      }
    }
  }
  return out;
}

// 显式引用避免 tree-shake（并保护 SB alias）
void ({} as SB);
