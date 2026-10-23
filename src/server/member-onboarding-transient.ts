// Allowlist only: permission, identity, malformed schema and unknown errors never retry.
export function transientOnboardingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.message === 'provider_temporarily_unavailable') return true;
  const cause = error.cause as {code?: unknown}|undefined;
  return ['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN'].includes(String(cause?.code));
}
export function temporaryProjectionFailure(reason: string|null|undefined): boolean {
  return reason === 'youzan_read_unavailable';
}