// Shared retry classification and redacted structured logging for the two recognition
// entry points (quick title + full recognition). Keep this module free of extensionless
// imports: node-run tests import it through product-title.server.ts directly.

export function isRecognitionTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: string }).name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError" || name === "TimeoutError" || /timed? ?out|aborted/i.test(message);
}

/** HTTP status carried on a recognition error: explicit `status` property first, then the "AI gateway NNN" message. */
export function extractRecognitionHttpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 100 && status <= 599) return status;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = message.match(/\b([1-5]\d{2})\b/);
  return match ? Number(match[1]) : null;
}

/** Permanent failures must fail fast: every 4xx except 408/429, transport misconfig, flagged parse errors. */
export function isPermanentRecognitionError(error: unknown): boolean {
  if (!error) return false;
  const shape = error as { name?: string; noRetry?: unknown };
  if (shape.name === "ListingAiTransportConfigError" || shape.noRetry === true) return true;
  const status = extractRecognitionHttpStatus(error);
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Retryable = not permanent: timeouts, network resets, 408/429/5xx and unknown transient errors. */
export function isRetryableRecognitionError(error: unknown): boolean {
  return !isPermanentRecognitionError(error);
}

export type RecognitionErrorKind = "timeout" | "permanent_4xx" | "transient" | "parse" | "config" | "consent";

export function recognitionErrorKind(error: unknown): RecognitionErrorKind {
  if (isRecognitionTimeoutError(error)) return "timeout";
  const shape = error as { name?: string; noRetry?: unknown } | null;
  if (shape?.name === "ListingAiTransportConfigError") return "config";
  if (shape?.noRetry === true) return "parse";
  const status = extractRecognitionHttpStatus(error);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "permanent_4xx";
  return "transient";
}

/**
 * Structured, redacted recognition log line. By construction it carries only ids, counts,
 * durations and status codes — never request bodies, images, base64, tokens or upstream text.
 */
export function logRecognitionEvent(event: {
  event: "product_recognition" | "product_title";
  request_id: string;
  source?: "erp" | "handheld" | "migration";
  model?: string;
  attempts: number;
  duration_ms: number;
  outcome: "completed" | "fallback" | "failed" | "aborted";
  http_status?: number | null;
  error_kind?: RecognitionErrorKind | null;
}): void {
  const line = JSON.stringify(event);
  if (event.outcome === "completed") console.info(line);
  else console.warn(line);
}
