/**
 * 有赞订单同步游标：固定窗口 + 切片结果判定（纯逻辑，可单测）。
 *
 * 铁律：
 *  - 窗口边界只由自然 UTC 边界推出，绝不能掺 Date.now() 的毫秒，否则每次入队
 *    都会生成一批"看起来不同"的窗口，唯一键失效、永远重复跑。
 *  - 失败 / 空窗口必须区分：全部接口版本都失败时绝不能当作"这个窗口跑完了"。
 *  - attempts 只统计"连续失败"，每成功推进一页就清零，长窗口（>60 页）不会耗尽。
 */
export const MAX_ATTEMPTS = 8;

export type FixedWindow = {
  shop_id: string;
  window_start: string;
  window_end: string;
};

export function buildFixedWindows(input: {
  shopIds: string[];
  now: Date;
  days: number;
  windowHours: number;
}): FixedWindow[] {
  const windowHours = Math.max(1, Math.min(Math.floor(input.windowHours), 72));
  const days = Math.max(1, Math.min(Math.floor(input.days), 180));
  const spanMs = windowHours * 3_600_000;

  // 对齐到自然 UTC 边界：结束点取"当前时间所在窗口的上边界"
  const nowMs = input.now.getTime();
  const endMs = Math.ceil(nowMs / spanMs) * spanMs;
  const startMs = endMs - days * 86_400_000;

  const windows: FixedWindow[] = [];
  for (const shopId of input.shopIds) {
    for (let t = startMs; t < endMs; t += spanMs) {
      windows.push({
        shop_id: shopId,
        window_start: new Date(t).toISOString(),
        window_end: new Date(t + spanMs).toISOString(),
      });
    }
  }
  return windows;
}

export type SliceResultLike = {
  ok: boolean;
  count: number;
  message: string;
  next_page: number | null;
  method_label: string | null;
};

export type SliceOutcome = {
  /** pending = 还有下一页；done = 窗口跑完；error = 本次失败可重试；failed = 重试用尽 */
  status: "pending" | "done" | "error" | "failed";
  next_page: number;
  method_label: string | null;
  attempts: number;
  empty: boolean;
  reason: string | null;
};

export function classifySliceOutcome(
  result: SliceResultLike,
  ctx: { startPage: number; previousAttempts: number },
): SliceOutcome {
  const attemptsOnFailure = ctx.previousAttempts + 1;

  const fail = (reason: string): SliceOutcome => ({
    status: attemptsOnFailure >= MAX_ATTEMPTS ? "failed" : "error",
    // 失败时绝不推进游标，也绝不写成 null（null 会被误当作"跑完了"）
    next_page: ctx.startPage,
    method_label: result.method_label,
    attempts: attemptsOnFailure,
    empty: false,
    reason,
  });

  if (!result.ok) return fail(result.message || "slice_failed");

  if (result.next_page === null) {
    return {
      status: "done",
      next_page: ctx.startPage,
      method_label: result.method_label,
      attempts: 0,
      empty: result.count === 0,
      reason: null,
    };
  }

  if (result.next_page <= ctx.startPage) {
    // 成功却没有推进：再跑一次也是同一页，视为异常而不是无限循环
    return fail("slice_made_no_progress");
  }

  return {
    status: "pending",
    next_page: result.next_page,
    method_label: result.method_label,
    attempts: 0,
    empty: false,
    reason: null,
  };
}
