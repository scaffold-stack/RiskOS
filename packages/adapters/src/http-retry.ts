import https from "node:https";

const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000] as const;
const dohCache = new Map<string, { address: string; expiresAt: number }>();

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

/**
 * Same rate-limit retry behavior, but recovers from local DNS failures by
 * resolving the hostname over HTTPS DoH and reconnecting with SNI preserved.
 * Used for market-quote hosts that some router/ISP resolvers refuse.
 */
export async function fetchWithDnsFallback(
  request: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  try {
    return await fetchWithRateLimitRetry(request, input, init, timeoutMs);
  } catch (error) {
    if (!isDnsResolutionFailure(error)) throw error;
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "https:") throw error;
    const address = await resolveHostnameViaDoh(url.hostname);
    return fetchHttpsViaResolvedAddress(url, address, init, timeoutMs);
  }
}

function isDnsResolutionFailure(error: unknown): boolean {
  const codes = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") codes.add(code);
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return codes.has("ENOTFOUND") || codes.has("EAI_AGAIN") || codes.has("EREFUSED");
}

async function resolveHostnameViaDoh(hostname: string): Promise<string> {
  const cached = dohCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.address;

  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
    {
      headers: { accept: "application/dns-json", "user-agent": "riskos/0.1" },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`DoH lookup for ${hostname} returned ${response.status}`);
  const body = (await response.json()) as {
    Answer?: Array<{ type?: number; data?: string; TTL?: number }>;
  };
  const record = body.Answer?.find((item) => item.type === 1 && typeof item.data === "string");
  if (!record?.data) throw new Error(`DoH lookup for ${hostname} returned no A record`);
  const ttlSeconds = typeof record.TTL === "number" && record.TTL > 0 ? record.TTL : 30;
  dohCache.set(hostname, {
    address: record.data,
    expiresAt: Date.now() + Math.min(ttlSeconds, 120) * 1_000,
  });
  return record.data;
}

function fetchHttpsViaResolvedAddress(
  url: URL,
  address: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", url.host);
  if (!headers.has("user-agent")) headers.set("user-agent", "riskos/0.1");

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: address,
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers: Object.fromEntries(headers.entries()),
        timeout: timeoutMs,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        incoming.on("end", () => {
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (value == null) continue;
            responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(
            new Response(body, {
              status: incoming.statusCode ?? 0,
              statusText: incoming.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error(`HTTPS request to ${url.hostname} timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
    if (init.body != null) {
      if (typeof init.body === "string" || init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
        request.end(init.body);
      } else {
        reject(new Error("fetchWithDnsFallback only supports buffered request bodies"));
        return;
      }
    } else {
      request.end();
    }
  });
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

/** Bound concurrent async work without losing result order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]!, index);
      }
    }),
  );
  return results;
}

/**
 * Shared FIFO gate for Stacks read-only / tip traffic. Overview adapters and the
 * yield catalog previously stampeded the same provider tip and produced 429s that
 * froze vault APYs as unavailable or zeroed partial catalogs.
 */
export function createConcurrencyGate(limit: number) {
  const max = Math.max(1, limit);
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = () => {
    while (active < max && queue.length > 0) {
      active += 1;
      queue.shift()!();
    }
  };

  return async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      pump();
    });
    try {
      return await work();
    } finally {
      active -= 1;
      pump();
    }
  };
}

/** Process-wide Stacks read budget shared by adapters and the yield catalog. */
export const stacksReadGate = createConcurrencyGate(2);
