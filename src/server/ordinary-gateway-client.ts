import type { CreatePaymentInput, RefundInput } from "./wechat-ordinary-client";

export interface OrdinaryGatewayClientConfig {
  url: string;
  token: string;
  merchantId: string;
  appId: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function unknownResult(): never {
  throw Object.assign(
    new Error("Payment result unknown; query the original order before retrying"),
    {
      code: "payment_result_unknown",
    },
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid gateway response");
  return value as Record<string, unknown>;
}

/**
 * 腾讯云网关适配层：ERP 只发出业务请求，微信 RSA 签名 / APIv3 加解密全部由网关完成。
 *
 * 铁律：
 *  - 写操作（下单、退款）绝不在结果未知时盲目重试，只回 payment_result_unknown，由查单收敛；
 *  - 只读查询可安全重试；
 *  - 所有请求带超时，网关不可达不会挂住小程序请求。
 */
export function createOrdinaryGatewayClient({
  url,
  token,
  merchantId,
  appId,
  timeoutMs = 8000,
  fetchImpl = fetch,
}: OrdinaryGatewayClientConfig) {
  async function call(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown; idempotencyKey?: string },
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${url}${path}`, {
        method: init.method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Merchant-Id": merchantId,
          "X-App-Id": appId,
          ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const text = await response.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 只读查询：网络异常/5xx 可安全重试一次。 */
  async function read(path: string, notFoundCode: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { status, body } = await call(path, { method: "GET" });
        if (status === 404) throw Object.assign(new Error("Not found"), { code: notFoundCode });
        if (status >= 500) {
          lastError = new Error(`Gateway HTTP ${status}`);
          continue;
        }
        if (status !== 200) throw new Error(`Gateway rejected request (HTTP ${status})`);
        return body ? record(body) : null;
      } catch (error) {
        if ((error as { code?: string }).code === notFoundCode) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Gateway unavailable");
  }

  /** 写操作：结果未知一律上抛 payment_result_unknown，不重复下单/重复退款。 */
  async function write(path: string, body: unknown, idempotencyKey: string) {
    let result: { status: number; body: Record<string, unknown> | null };
    try {
      result = await call(path, { method: "POST", body, idempotencyKey });
    } catch {
      return unknownResult();
    }
    if (result.status >= 500 || result.status === 408 || result.status === 429)
      return unknownResult();
    if (result.status !== 200 && result.status !== 201) {
      const code = result.body?.["code"];
      throw Object.assign(new Error(`Gateway rejected request (HTTP ${result.status})`), {
        code: typeof code === "string" ? code : undefined,
      });
    }
    return result.body ? record(result.body) : null;
  }

  return {
    async createPayment(input: CreatePaymentInput) {
      const body = await write(
        "/v1/ordinary/payments",
        {
          merchant_id: merchantId,
          app_id: appId,
          out_trade_no: input.orderNo,
          amount: { total: input.totalFen, currency: "CNY" },
          payer: { openid: input.openid },
          description: input.description,
          time_expire: input.expiresAt ?? null,
        },
        input.orderNo,
      );
      const prepayId = body?.["prepay_id"];
      const payload = body?.["payment_payload"];
      if (typeof prepayId !== "string" || !prepayId || !payload || typeof payload !== "object")
        throw new Error("Invalid gateway prepay response");
      return { prepay_id: prepayId, payment_payload: payload as Record<string, unknown> };
    },
    async queryPayment(orderNo: string) {
      return await read(`/v1/ordinary/payments/${encodeURIComponent(orderNo)}`, "ORDERNOTEXIST");
    },
    async closePayment(orderNo: string) {
      return await write(
        `/v1/ordinary/payments/${encodeURIComponent(orderNo)}/close`,
        { merchant_id: merchantId },
        `close:${orderNo}`,
      );
    },
    async refund(input: RefundInput) {
      return await write(
        "/v1/ordinary/refunds",
        {
          merchant_id: merchantId,
          out_trade_no: input.orderNo,
          out_refund_no: input.refundNo,
          amount: { total: input.totalFen, refund: input.refundFen, currency: "CNY" },
          reason: input.reason ?? null,
        },
        input.refundNo,
      );
    },
    async queryRefund(refundNo: string) {
      return await read(
        `/v1/ordinary/refunds/${encodeURIComponent(refundNo)}`,
        "RESOURCE_NOT_EXISTS",
      );
    },
  };
}
