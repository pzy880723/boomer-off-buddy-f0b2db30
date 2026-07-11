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
                // 2026-07 audit rule 9：消息推送体不可信，异步再拉一次 trade.get/4.0.2
                // 详情覆写 youzan_orders，避免只落 push body 造成字段缺失。
                await refreshTradeDetail(supabaseAdmin, shopId, kdtId, event).catch((e: unknown) =>
                  console.warn("[youzan-message] trade.get 补拉失败：", e),
                );
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
  // 2026-07 阶段 4/5：所有渠道销售扣减统一走 commit_sale RPC。
  // - RPC 内部：原子扣库存 + 幂等 + 自动 enqueue channel_sync_outbox (set_stock_zero / delist)
  // - dedupe key = (source_channel, source_order_id, event_type)
  const items = extractOrderItems(event);
  const tid = String(
    (event as { tid?: string | number }).tid ??
      (event as { trade?: { tid?: string | number } }).trade?.tid ??
      (event as { data?: { tid?: string | number } }).data?.tid ??
      "",
  );
  if (!tid) return;
  const supa = sb as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          c: string,
          v: unknown,
        ) => {
          eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: { sku_id: string } | null }> };
        };
      };
    };
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const locQuery = (sb as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: { id?: string } | null }> };
      };
    };
  }).from("inv_locations").select("id").eq("shop_id", shopId);
  const { data: loc } = await locQuery.maybeSingle();
  const locationId = (loc as { id?: string } | null)?.id ?? null;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // 找 (shop, item_id) → sku_id （优先新表，回退旧 sku_youzan_links）
    let skuId: string | null = null;
    const newRow = await supa
      .from("sku_channel_listings")
      .select("sku_id")
      .eq("shop_id", shopId)
      .eq("external_item_id", String(it.item_id))
      .maybeSingle();
    if (newRow.data?.sku_id) {
      skuId = String(newRow.data.sku_id);
    } else {
      const legacy = await supa
        .from("sku_youzan_links")
        .select("sku_id")
        .eq("shop_id", shopId)
        .eq("yz_item_id", it.item_id)
        .maybeSingle();
      if (legacy.data?.sku_id) skuId = String(legacy.data.sku_id);
    }
    if (!skuId) continue;

    // 每单每行独立 source_order_id，防止多行订单被幂等吞掉
    const orderKey = items.length > 1 ? `${tid}#${i}` : tid;
    await supa.rpc("commit_sale", {
      p_sku_id: skuId,
      p_source_channel: "youzan_offline",
      p_source_order_id: orderKey,
      p_source_shop_id: shopId,
      p_event_type: "paid",
      p_epc: null,
      p_location_id: locationId,
      p_raw_payload: {
        item_id: it.item_id,
        qty: it.qty,
        tid,
      } as never,
    });
  }
}

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
          eq: (c: string, v: unknown) => { maybeSingle: () => Promise<{ data: { sku_id: string } | null }> };
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
      refund_source_channel: "youzan_offline",
      refund_source_order_id: tid,
      refund_status: "refunded",
      inspection_result: null,
      channel_restore_status: "pending",
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
): Promise<void> {
  const tid = extractTid(event);
  if (!tid) return;
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
  if (!shop) return;
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
  if (!trade) return;
  await supa.from("youzan_orders").upsert(
    {
      shop_id: shopId,
      kdt_id: kdtId,
      tid,
      raw: trade as unknown,
    } as never,
    { onConflict: "kdt_id,tid" },
  );
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

// 显式引用避免 tree-shake（并保护 SB alias）
void ({} as SB);
