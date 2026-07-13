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
import { reconcileYouzanTradeSale } from "@/lib/youzan-sale.functions";
import { extractYouzanSale } from "@/lib/youzan-sale.server";

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

        let logId: string | null = null;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

          // 记 log（成功/失败都记）
          const { data: log } = await supabaseAdmin
            .from("youzan_sync_logs")
            .insert({
              action: "message_push",
              status: "running",
              message: `type=${payload.type ?? "?"} kdt=${payload.kdt_id ?? "?"}`,
              raw: { payload, event } as never,
              kdt_id: payload.kdt_id ?? null,
            } as never)
            .select("id")
            .single();
          logId = log?.id ?? null;

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
                // 2026-07 audit rule 9：消息推送体不可信，异步再拉一次 trade.get/4.0.2
                // 先拉详情，再扣库存；推送通常只有 tid，没有商品行。
                let detail: Record<string, unknown> | null = null;
                try {
                  detail = await refreshTradeDetail(supabaseAdmin, shopId, kdtId, event);
                } catch (e) {
                  console.warn("[youzan-message] trade.get 补拉失败：", e);
                }
                const trade = detail ?? event;
                const extracted = extractYouzanSale(trade);
                if (!extracted || extracted.items.length === 0) {
                  throw new Error("订单详情缺少商品行，未执行库存扣减");
                }
                const sale = await reconcileYouzanTradeSale({ trade, shopId });
                if (sale.unmatched > 0 || sale.failed > 0) {
                  throw new Error(
                    `库存扣减未完成：processed=${sale.processed} unmatched=${sale.unmatched} failed=${sale.failed}`,
                  );
                }
              }
              // 退款事件 → 加回库存
              if (type === "REFUND_RefundSuccess" || type === "REFUND_SellerAgree") {
                await handleRefundEvent(supabaseAdmin, shopId, event);
              }
            }
          }
          if (logId) {
            await supabaseAdmin
              .from("youzan_sync_logs")
              .update({
                status: "ok",
                message: `type=${payload.type ?? "?"} kdt=${payload.kdt_id ?? "?"} 已处理`,
                finished_at: new Date().toISOString(),
              } as never)
              .eq("id", logId);
          }
        } catch (e) {
          if (logId) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            await supabaseAdmin
              .from("youzan_sync_logs")
              .update({
                status: "error",
                error: e instanceof Error ? e.message : String(e),
                finished_at: new Date().toISOString(),
              } as never)
              .eq("id", logId);
          }
          // 业务异常已持久化；仍确认接收，轮询同步会再次幂等对账。
          console.error("[youzan-message]", e);
        }

        return Response.json({ code: 0, msg: "success" });
      },
    },
  },
});

async function handleRefundEvent(sb: unknown, shopId: string, event: Record<string, unknown>) {
  // 2026-07 阶段 6：退款不再自动回库存，先建 return_inspections 待人工复检；
  // 复检通过后由 restore_after_return_inspection RPC 回补 + 上架。
  const items = extractOrderItems(event);
  const tid = String(
    (event as { tid?: string | number }).tid ??
      (event as { trade?: { tid?: string | number } }).trade?.tid ??
      (event as { data?: { tid?: string | number } }).data?.tid ??
      "",
  );
  const supa = sb as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          c: string,
          v: unknown,
        ) => {
          eq: (
            c: string,
            v: unknown,
          ) => { maybeSingle: () => Promise<{ data: { sku_id: string } | null }> };
        };
      };
      insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    };
  };
  for (const it of items) {
    let skuId: string | null = null;
    const newRow = await supa
      .from("sku_channel_listings")
      .select("sku_id")
      .eq("shop_id", shopId)
      .eq("external_item_id", String(it.item_id))
      .maybeSingle();
    if (newRow.data?.sku_id) skuId = String(newRow.data.sku_id);
    if (!skuId) {
      const legacy = await supa
        .from("sku_youzan_links")
        .select("sku_id")
        .eq("shop_id", shopId)
        .eq("yz_item_id", it.item_id)
        .maybeSingle();
      if (legacy.data?.sku_id) skuId = String(legacy.data.sku_id);
    }
    if (!skuId) continue;
    await supa.from("return_inspections").insert({
      sku_id: skuId,
      refund_source_channel: "youzan_branch_offline",
      refund_source_order_id: tid,
      refund_status: "refunded",
      inspection_result: null,
      channel_restore_status: "pending",
    });
  }
}

// 从有赞消息里挖出 order_items（不同事件字段结构略有差异）
function extractOrderItems(
  event: Record<string, unknown>,
): Array<{ item_id: number; qty: number }> {
  return (extractYouzanSale(event)?.items ?? []).map((item) => ({
    item_id: item.itemId,
    qty: item.quantity,
  }));
}

// ============================================================
// refreshTradeDetail —— 2026-07 audit rule 9
// 消息推送体不能作为唯一真源；收到 TRADE_* 后再用店铺 token
// 调 youzan.trade.get/4.0.2 拉一次完整详情，覆写 youzan_orders.raw。
// ============================================================
async function refreshTradeDetail(
  sb: unknown,
  shopId: string,
  kdtId: number,
  event: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const tid = extractTid(event);
  if (!tid) return null;
  const supa = sb as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          c: string,
          v: unknown,
        ) => { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> };
      };
      upsert: (row: unknown, opts?: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
  const { data: shop } = await supa
    .from("youzan_shops")
    .select("id, kdt_id, role, access_token, refresh_token, token_expires_at")
    .eq("id", shopId)
    .maybeSingle();
  if (!shop) return null;
  const { ensureAccessToken, callYouzanApiVerbose } = await import("@/lib/youzan.functions");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const token = await ensureAccessToken(shop as any);
  const res = await callYouzanApiVerbose({
    accessToken: token,
    method: "youzan.trade.get",
    version: "4.0.2",
    params: { tid },
    timeoutMs: 20_000,
  });
  const trade = res.payload as Record<string, unknown> | null;
  if (!trade) return null;
  await supa.from("youzan_orders").upsert(
    {
      shop_id: shopId,
      kdt_id: kdtId,
      tid,
      raw: trade as unknown,
    } as never,
    { onConflict: "kdt_id,tid" },
  );
  return trade;
}

function extractTid(event: Record<string, unknown>): string {
  const direct =
    (typeof event.tid === "string" && event.tid) ||
    (typeof event.tid === "number" && String(event.tid)) ||
    "";
  if (direct) return direct;
  const trade = event.trade as Record<string, unknown> | undefined;
  if (trade) {
    const t =
      (typeof trade.tid === "string" && trade.tid) ||
      (typeof trade.tid === "number" && String(trade.tid)) ||
      "";
    if (t) return t;
  }
  const data = event.data as Record<string, unknown> | undefined;
  if (data) {
    const t =
      (typeof data.tid === "string" && data.tid) ||
      (typeof data.tid === "number" && String(data.tid)) ||
      "";
    if (t) return t;
  }
  return "";
}
