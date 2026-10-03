import { z } from "zod";

type ApiResponse<T> =
  | { ok: true; data: T; replayed?: boolean }
  | { ok: false; message?: string; error?: string; code?: string };

const confirmedSale = z.object({
  order_id: z.string().uuid(),
  order_no: z.string().min(1),
  total_amount: z.number().finite().nonnegative(),
});

export function isConfirmedSale(data: unknown): boolean {
  return confirmedSale.safeParse(data).success;
}

export async function posRequest<T>(
  path: string,
  token: string,
  init?: RequestInit,
  validateData?: (data: unknown) => boolean,
): Promise<ApiResponse<T>> {
  const unknownResult = (message: string): ApiResponse<T> => ({
    ok: false, code: "result_unknown", message,
  });
  try {
    const response = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(25_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
      return unknownResult(`接口返回异常（HTTP ${response.status}）`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("ok" in body)) {
      return unknownResult("接口返回内容不完整，请保留原单重试");
    }
    if (response.status >= 500) return unknownResult("服务器暂时不可用，请保留原单重试");
    if (body.ok === true && response.ok && "data" in body && (!validateData || validateData(body.data))) {
      return body as ApiResponse<T>;
    }
    if (body.ok === false && "message" in body && typeof body.message === "string" && body.message.length > 0) {
      return body as ApiResponse<T>;
    }
    return unknownResult("接口返回内容不完整，请保留原单重试");
  } catch {
    return unknownResult("网络连接失败或超时，请检查网络后重试");
  }
}
