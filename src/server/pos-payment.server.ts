/**
 * POS 扫码支付编排：金额重算 → 门店主体校验 → 调支付机构 → 支付成功后落销售。
 * 只有支付机构确认成功（同步返回 SUCCESS 或验签通过的异步回调）才会完成销售与扣库存。
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { calculatePosDiscount } from "@/lib/pos/pos-policy";
import {
  authCodeLast4,
  buildOutTradeNo,
  canTransitionPosPayment,
  type PosPaymentMode,
  type PosPaymentStatus,
  type PosScanProvider,
} from "@/lib/pos/pos-scan-payment";
import { sha256Hex } from "@/server/pos-payment-provider.server";

export type PosPaymentAttempt = {
  id: string;
  location_id: string;
  shift_id: string;
  operator_id: string;
  provider: PosScanProvider;
  mode: PosPaymentMode;
  out_trade_no: string;
  amount: number;
  status: PosPaymentStatus;
  provider_transaction_id: string | null;
  qr_content: string | null;
  code_url: string | null;
  expires_at: string | null;
  client_op_id: string;
  customer_id: string | null;
  sale_payload: {
    items?: Array<{ sku_id: string; quantity: number }>;
    discount?: { type: string; value: number; reason?: string } | null;
    authorization_id?: string | null;
    note?: string | null;
  };
  order_id: string | null;
  error_code: string | null;
  error_message: string | null;
  paid_at: string | null;
  payment_profile_id: string | null;
  settlement_subject_id: string | null;
};

export type PosPaymentFailure = { code: string; message: string; status: number };

const ATTEMPT_COLUMNS =
  "id,location_id,shift_id,operator_id,provider,mode,out_trade_no,amount,status," +
  "provider_transaction_id,qr_content,code_url,expires_at,client_op_id,customer_id," +
  "sale_payload,order_id,error_code,error_message,paid_at,payment_profile_id,settlement_subject_id";

export type StoreMerchant = {
  paymentProfileId: string;
  subjectId: string;
  subjectName: string;
  wechatSubMchId: string | null;
  wechatSubAppId: string | null;
  alipaySellerId: string | null;
};

/** 门店独立商户主体；未完成认证/开通一律不允许收款。 */
export async function resolveStoreMerchant(
  locationId: string,
  provider: PosScanProvider,
): Promise<{ ok: true; merchant: StoreMerchant } | { ok: false; failure: PosPaymentFailure }> {
  const notConfigured: PosPaymentFailure = {
    code: "payment_not_configured",
    message: "该门店尚未完成支付主体认证或支付机构开通，暂时无法收款",
    status: 503,
  };
  const { data: profile, error } = await supabaseAdmin
    .from("store_payment_profiles" as never)
    .select("id,subject_id,status,is_enabled")
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) return { ok: false, failure: { code: "server_error", message: error.message, status: 500 } };
  const profileRow = profile as unknown as {
    id: string;
    subject_id: string | null;
    status: string;
    is_enabled: boolean;
  } | null;
  if (!profileRow?.subject_id || !profileRow.is_enabled || profileRow.status !== "active") {
    return { ok: false, failure: notConfigured };
  }
  const { data: subject, error: subjectError } = await supabaseAdmin
    .from("payment_subjects" as never)
    .select(
      "id,legal_name,erp_verification_status,provider_application_status,wechat_sub_mchid,wechat_appid,alipay_seller_id",
    )
    .eq("id", profileRow.subject_id)
    .maybeSingle();
  if (subjectError && !/alipay_seller_id/.test(subjectError.message)) {
    return { ok: false, failure: { code: "server_error", message: subjectError.message, status: 500 } };
  }
  let subjectRow = subject as unknown as {
    id: string;
    legal_name: string;
    erp_verification_status: string;
    provider_application_status: string;
    wechat_sub_mchid: string | null;
    wechat_appid: string | null;
    alipay_seller_id?: string | null;
  } | null;
  if (!subjectRow) {
    const fallback = await supabaseAdmin
      .from("payment_subjects" as never)
      .select(
        "id,legal_name,erp_verification_status,provider_application_status,wechat_sub_mchid,wechat_appid",
      )
      .eq("id", profileRow.subject_id)
      .maybeSingle();
    if (fallback.error) {
      return { ok: false, failure: { code: "server_error", message: fallback.error.message, status: 500 } };
    }
    subjectRow = fallback.data as unknown as typeof subjectRow;
  }
  if (
    !subjectRow ||
    subjectRow.erp_verification_status !== "approved" ||
    subjectRow.provider_application_status !== "active"
  ) {
    return { ok: false, failure: notConfigured };
  }
  if (provider === "wechat" && !subjectRow.wechat_sub_mchid) {
    return { ok: false, failure: notConfigured };
  }
  return {
    ok: true,
    merchant: {
      paymentProfileId: profileRow.id,
      subjectId: subjectRow.id,
      subjectName: subjectRow.legal_name,
      wechatSubMchId: subjectRow.wechat_sub_mchid,
      wechatSubAppId: subjectRow.wechat_appid,
      alipaySellerId: subjectRow.alipay_seller_id ?? null,
    },
  };
}

export type SaleItemInput = { sku_id: string; quantity: number };
export type SaleDiscountInput = { type: "amount" | "percentage" | "final_price"; value: number; reason: string };

/** 服务端重算应收金额，并校验可售与库存。绝不信任 APP 传来的金额。 */
export async function recomputePayableAmount(input: {
  locationId: string;
  items: SaleItemInput[];
  discount?: SaleDiscountInput;
}): Promise<
  | {
      ok: true;
      subtotal: number;
      discount_total: number;
      payable_total: number;
      description: string;
    }
  | { ok: false; failure: PosPaymentFailure }
> {
  const skuIds = [...new Set(input.items.map((item) => item.sku_id))];
  const { data, error } = await supabaseAdmin
    .from("inv_skus")
    .select("id,name,price_tier,status,is_display,sale_ownership,discount_eligible")
    .in("id", skuIds);
  if (error) return { ok: false, failure: { code: "server_error", message: error.message, status: 500 } };
  const skus = (data ?? []) as unknown as Array<{
    id: string;
    name: string;
    price_tier: number;
    status: string;
    is_display: boolean;
    sale_ownership: string;
    discount_eligible: boolean;
  }>;
  if (skus.length !== skuIds.length) {
    return { ok: false, failure: { code: "sku_not_found", message: "部分商品不存在", status: 404 } };
  }
  const skuMap = new Map(skus.map((sku) => [sku.id, sku]));
  for (const sku of skus) {
    if (sku.status !== "active" || !sku.is_display) {
      return {
        ok: false,
        failure: { code: "sku_not_sellable", message: `商品「${sku.name}」当前不可售`, status: 422 },
      };
    }
  }
  for (const item of input.items) {
    const { data: available, error: availableError } = await supabaseAdmin.rpc(
      "sales_sku_available_qty" as never,
      { p_sku_id: item.sku_id, p_location_id: input.locationId } as never,
    );
    if (availableError) {
      return { ok: false, failure: { code: "server_error", message: availableError.message, status: 500 } };
    }
    if (Number(available ?? 0) < item.quantity) {
      return {
        ok: false,
        failure: {
          code: "insufficient_stock",
          message: `商品「${skuMap.get(item.sku_id)?.name ?? item.sku_id}」库存不足`,
          status: 409,
        },
      };
    }
  }

  const lines = input.items.map((item) => {
    const sku = skuMap.get(item.sku_id)!;
    return {
      sku_id: item.sku_id,
      quantity: item.quantity,
      unit_price: Number(sku.price_tier) || 0,
      discount_eligible: sku.discount_eligible && sku.sale_ownership === "owned",
    };
  });
  let totals;
  try {
    totals = input.discount
      ? calculatePosDiscount(lines, input.discount)
      : calculatePosDiscount(lines, { type: "amount", value: 0 });
  } catch (discountError) {
    return {
      ok: false,
      failure: {
        code: "discount_not_allowed",
        message: discountError instanceof Error ? discountError.message : "优惠不可用",
        status: 422,
      },
    };
  }
  if (totals.payable_total <= 0) {
    return { ok: false, failure: { code: "amount_invalid", message: "应收金额必须大于 0", status: 422 } };
  }
  const firstName = skuMap.get(input.items[0].sku_id)?.name ?? "商品";
  const description =
    input.items.length > 1 ? `${firstName} 等${input.items.length}件商品` : firstName;
  return {
    ok: true,
    subtotal: totals.subtotal,
    discount_total: totals.discount_total,
    payable_total: totals.payable_total,
    description,
  };
}

export async function findAttemptByClientOpId(clientOpId: string) {
  const { data, error } = await supabaseAdmin
    .from("pos_payment_attempts" as never)
    .select(ATTEMPT_COLUMNS)
    .eq("client_op_id", clientOpId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as PosPaymentAttempt) ?? null;
}

export async function findAttemptById(id: string) {
  const { data, error } = await supabaseAdmin
    .from("pos_payment_attempts" as never)
    .select(ATTEMPT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as PosPaymentAttempt) ?? null;
}

export async function findAttemptByOutTradeNo(outTradeNo: string) {
  const { data, error } = await supabaseAdmin
    .from("pos_payment_attempts" as never)
    .select(ATTEMPT_COLUMNS)
    .eq("out_trade_no", outTradeNo)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as PosPaymentAttempt) ?? null;
}

export async function createAttempt(input: {
  locationId: string;
  shiftId: string;
  operatorId: string;
  provider: PosScanProvider;
  mode: PosPaymentMode;
  amount: number;
  clientOpId: string;
  customerId?: string | null;
  merchant: StoreMerchant;
  authCode?: string | null;
  expiresAt?: Date | null;
  salePayload: PosPaymentAttempt["sale_payload"];
}) {
  const outTradeNo = buildOutTradeNo(new Date(), crypto.randomUUID());
  const { data, error } = await supabaseAdmin
    .from("pos_payment_attempts" as never)
    .insert({
      location_id: input.locationId,
      shift_id: input.shiftId,
      operator_id: input.operatorId,
      payment_profile_id: input.merchant.paymentProfileId,
      settlement_subject_id: input.merchant.subjectId,
      provider: input.provider,
      mode: input.mode,
      out_trade_no: outTradeNo,
      amount: input.amount,
      status: "pending",
      client_op_id: input.clientOpId,
      customer_id: input.customerId ?? null,
      // 只保存不可逆哈希与后四位，明文付款码仅在内存中传给支付机构
      auth_code_hash: input.authCode ? await sha256Hex(input.authCode) : null,
      auth_code_last4: input.authCode ? authCodeLast4(input.authCode) : null,
      expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
      sale_payload: input.salePayload,
    } as never)
    .select(ATTEMPT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as PosPaymentAttempt;
}

export async function updateAttempt(id: string, patch: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin
    .from("pos_payment_attempts" as never)
    .update(patch as never)
    .eq("id", id)
    .select(ATTEMPT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as PosPaymentAttempt;
}

/**
 * 支付成功后完成销售：复用 pos_complete_sale_v2（库存、分账、优惠一致）。
 * client_op_id 与 attempt 一一对应，回调重放不会重复扣款或重复销售。
 */
export async function finalizePaidAttempt(
  attempt: PosPaymentAttempt,
  input: { providerTransactionId: string; paidAt?: string; providerResponse?: Record<string, unknown> },
): Promise<PosPaymentAttempt> {
  if (attempt.status === "paid" && attempt.order_id) return attempt;
  const items = attempt.sale_payload.items ?? [];
  if (items.length === 0) throw new Error("支付流水缺少销售明细");
  const { data, error } = await supabaseAdmin.rpc(
    "pos_complete_sale_v2" as never,
    {
      p_shift_id: attempt.shift_id,
      p_operator_id: attempt.operator_id,
      p_client_op_id: attempt.client_op_id,
      p_items: items,
      p_tenders: [
        {
          provider: attempt.provider,
          amount: Number(attempt.amount),
          provider_transaction_id: input.providerTransactionId,
        },
      ],
      p_customer_id: attempt.customer_id ?? null,
      p_note: attempt.sale_payload.note ?? null,
      p_discount_snapshot: attempt.sale_payload.discount ?? {},
      p_benefit_snapshot: {},
      p_authorization_id: attempt.sale_payload.authorization_id ?? null,
    } as never,
  );
  if (error) {
    await updateAttempt(attempt.id, {
      error_code: "sale_failed",
      error_message: error.message,
    });
    throw new Error(error.message);
  }
  const result = data as unknown as { order_id: string };
  return updateAttempt(attempt.id, {
    status: "paid",
    provider_transaction_id: input.providerTransactionId,
    order_id: result.order_id,
    paid_at: input.paidAt ?? new Date().toISOString(),
    error_code: null,
    error_message: null,
    ...(input.providerResponse ? { provider_response: input.providerResponse } : {}),
  });
}

export async function markAttemptStatus(
  attempt: PosPaymentAttempt,
  status: PosPaymentStatus,
  extra: Record<string, unknown> = {},
) {
  if (!canTransitionPosPayment(attempt.status, status)) return attempt;
  return updateAttempt(attempt.id, { status, ...extra });
}

export type PosReceipt = {
  order_id: string;
  order_no: string;
  receipt_no: string | null;
  total_amount: number;
  subtotal: number;
  discount_total: number;
  payment_provider: string;
  provider_transaction_id: string | null;
  paid_at: string | null;
  location_name: string;
  cashier_name: string;
  customer_name?: string | null;
  items: Array<{
    name: string;
    sku_code: string | null;
    quantity: number;
    unit_price: number;
    line_total: number;
  }>;
};

export async function buildPosReceipt(attempt: PosPaymentAttempt): Promise<PosReceipt | null> {
  if (!attempt.order_id) return null;
  const [orderResult, itemsResult, receiptResult, locationResult, customerResult] =
    await Promise.all([
      supabaseAdmin
        .from("commerce_orders" as never)
        .select("id,order_no,subtotal,discount_total,total_amount,paid_at")
        .eq("id", attempt.order_id)
        .maybeSingle(),
      supabaseAdmin
        .from("commerce_order_items" as never)
        .select("sku_id,title_snapshot,unit_price,quantity,line_total")
        .eq("order_id", attempt.order_id),
      supabaseAdmin
        .from("pos_receipts" as never)
        .select("receipt_no")
        .eq("order_id", attempt.order_id)
        .maybeSingle(),
      supabaseAdmin.from("inv_locations").select("name").eq("id", attempt.location_id).maybeSingle(),
      attempt.customer_id
        ? supabaseAdmin
            .from("commerce_customers" as never)
            .select("nickname,phone")
            .eq("id", attempt.customer_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
  const order = orderResult.data as unknown as {
    id: string;
    order_no: string;
    subtotal: number;
    discount_total: number;
    total_amount: number;
    paid_at: string | null;
  } | null;
  if (!order) return null;
  const rawItems = (itemsResult.data ?? []) as unknown as Array<{
    sku_id: string;
    title_snapshot: string;
    unit_price: number;
    quantity: number;
    line_total: number;
  }>;
  const skuIds = [...new Set(rawItems.map((item) => item.sku_id))];
  const { data: skuRows } = skuIds.length
    ? await supabaseAdmin.from("inv_skus").select("id,sku_code").in("id", skuIds)
    : { data: [] };
  const skuCodes = new Map(
    ((skuRows ?? []) as unknown as Array<{ id: string; sku_code: string | null }>).map((sku) => [
      sku.id,
      sku.sku_code,
    ]),
  );
  const { data: operator } = await supabaseAdmin.auth.admin.getUserById(attempt.operator_id);
  const customer = customerResult.data as unknown as { nickname: string | null; phone: string | null } | null;
  return {
    order_id: order.id,
    order_no: order.order_no,
    receipt_no: (receiptResult.data as unknown as { receipt_no: string } | null)?.receipt_no ?? null,
    subtotal: Number(order.subtotal),
    discount_total: Number(order.discount_total),
    total_amount: Number(order.total_amount),
    payment_provider: attempt.provider,
    provider_transaction_id: attempt.provider_transaction_id,
    paid_at: attempt.paid_at ?? order.paid_at,
    location_name: (locationResult.data as unknown as { name: string } | null)?.name ?? "",
    cashier_name: operator?.user?.email ?? "",
    customer_name: customer?.nickname ?? customer?.phone ?? null,
    items: rawItems.map((item) => ({
      name: item.title_snapshot,
      sku_code: skuCodes.get(item.sku_id) ?? null,
      quantity: Number(item.quantity),
      unit_price: Number(item.unit_price),
      line_total: Number(item.line_total),
    })),
  };
}

export async function attemptResponse(attempt: PosPaymentAttempt) {
  const receipt = attempt.status === "paid" ? await buildPosReceipt(attempt) : null;
  return {
    id: attempt.id,
    provider: attempt.provider,
    mode: attempt.mode,
    status: attempt.status,
    amount: Number(attempt.amount),
    out_trade_no: attempt.out_trade_no,
    provider_transaction_id: attempt.provider_transaction_id,
    qr_content: attempt.qr_content,
    code_url: attempt.code_url,
    expires_at: attempt.expires_at,
    order_id: attempt.order_id,
    message: attempt.error_message,
    error_code: attempt.error_code,
    ...(receipt ? { receipt } : {}),
  };
}
