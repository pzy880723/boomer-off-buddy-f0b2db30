/**
 * 手持终端 Public API 业务错误码。
 *
 * APP 端按 `code` 字段直接做页面提示，HTTP 状态码用于通道层处理。
 * 改动需同步：
 *  - schemas.ts 的 ErrorResponse 示例
 *  - openapi.ts 的 ERROR_RESPONSES
 *  - docs/handheld-onboarding.md 的错误码表
 */
import { json } from "@/server/handheld-auth.server";

export const HANDHELD_ERROR_CODES = {
  unauthorized: { status: 401, message: "Missing or invalid token" },
  unauthorized_location: { status: 401, message: "Session location mismatch" },
  invalid_body: { status: 400, message: "Invalid request body" },
  validation_error: { status: 422, message: "Validation failed" },
  not_found: { status: 404, message: "Resource not found" },
  unlinked: { status: 404, message: "EPC not bound to any SKU" },
  already_exists: { status: 409, message: "Resource already exists / conflict" },
  transfer_required: { status: 409, message: "EPC is in another location, transfer required" },
  rate_limited: { status: 429, message: "AI gateway rate limited" },
  ai_credits_exhausted: { status: 402, message: "AI credits exhausted" },
  internal_error: { status: 500, message: "Internal server error" },
} as const;

export type HandheldErrorCode = keyof typeof HANDHELD_ERROR_CODES;

export function errCode(
  code: HandheldErrorCode,
  message?: string,
  extra?: Record<string, unknown>,
) {
  const def = HANDHELD_ERROR_CODES[code];
  return json(
    {
      ok: false,
      code,
      error: message ?? def.message,
      ...(extra || {}),
    },
    { status: def.status },
  );
}
