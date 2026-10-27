/** Preview orchestration only; no model, prompt, pixels, or provider call here. */
export function retouchRetryDelay(error: unknown, attempts: number): number | null {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= 3) return null;
  const e = error as { code?: string; status?: number; name?: string; message?: string } | null;
  if (!e) return null;
  const text = e.message ?? "";
  if (e.code === "ai_consent_revoked" || /permanent:|consent|invalid source|Original image|Unsupported original|Image too large|content_filter|safety|refusal|blocked/i.test(text)) return null;
  if (e.status !== undefined) {
    if (e.status === 429) return 15 * 60_000;
    return e.status >= 500 && e.status <= 599 ? 30_000 * 2 ** (attempts - 1) : null;
  }
  if (e.name === "TypeError" || e.name === "TimeoutError" || /HTTP (429|5\d\d)|AI gateway (429|5\d\d)|未返回图片（stop）|修图检查未通过/.test(text))
    return /429/.test(text) ? 15 * 60_000 : 30_000 * 2 ** (attempts - 1);
  return null;
}