const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const;

/**
 * Retry idempotent provider reads only when the provider explicitly rate-limits.
 * Other HTTP failures are returned unchanged so callers keep their fail-closed
 * behavior and do not amplify an upstream outage.
 */
export async function fetchWithRateLimitRetry(
  request: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await request(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 429 || attempt >= DEFAULT_RETRY_DELAYS_MS.length) return response;

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    await response.body?.cancel().catch(() => undefined);
    await delay(retryAfterMs ?? DEFAULT_RETRY_DELAYS_MS[attempt]!);
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 2_000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - Date.now()), 2_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
