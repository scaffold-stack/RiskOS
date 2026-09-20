import { describe, expect, it, vi } from "vitest";
import { RISKOS_SDK_VERSION, RiskOsClient, RiskOsClientError } from "./index.js";

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("RiskOsClient", () => {
  it("validates security-sensitive constructor options", () => {
    expect(() => new RiskOsClient({ baseUrl: "file:///tmp/riskos" })).toThrow(/http or https/);
    expect(() => new RiskOsClient({ baseUrl: "https://user:pass@example.com" })).toThrow(/credentials/);
    expect(() => new RiskOsClient({ baseUrl: "https://api.example.com", apiKey: "short" })).toThrow(/16/);
    expect(() => new RiskOsClient({ baseUrl: "https://api.example.com", timeoutMs: 0 })).toThrow(/positive/);
  });

  it("binds fetch for browser implementations that reject illegal invocation", async () => {
    const browserLikeFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(json({ status: "ok", dataMode: "live", execution: "advisory" }));
    }) as unknown as typeof fetch;
    const client = new RiskOsClient({ baseUrl: "https://api.example.com", fetch: browserLikeFetch });
    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
  });

  it("covers public address, market, and history endpoints with encoded input", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(new Headers(init?.headers).get("x-riskos-sdk-version")).toBe(RISKOS_SDK_VERSION);
      if (url.endsWith("/health")) return json({ status: "ok", dataMode: "live", execution: "advisory" });
      if (url.includes("/overview")) return json({ address: "SP 123", positions: {}, risks: [], portfolio: {} });
      if (url.includes("/history")) return json({ address: "SP 123", observations: [] });
      if (url.endsWith("/v1/yield/markets")) return json({ asOf: "2026-09-20T00:00:00Z", markets: [] });
      return json({ code: "NOT_FOUND", title: "Not found" }, 404);
    });
    const client = new RiskOsClient({
      baseUrl: "https://api.example.com/",
      fetch: fetchMock as unknown as typeof fetch,
      retries: 0,
    });

    await expect(client.health()).resolves.toMatchObject({ dataMode: "live" });
    await expect(client.getOverview("SP 123")).resolves.toMatchObject({ address: "SP 123" });
    await expect(client.getHistory("SP 123", { limit: 30 })).resolves.toMatchObject({ observations: [] });
    await expect(client.getYieldMarkets()).resolves.toMatchObject({ markets: [] });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/SP%20123/overview");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("limit=30");
    expect(() => client.getHistory("SP123", { limit: 0 })).toThrow(RangeError);
  });

  it("sends API keys, custom headers, cookies, and JSON bodies", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("rk_live_1234567890");
      expect(headers.get("x-tenant")).toBe("treasury");
      expect(headers.get("content-type")).toBe("application/json");
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(String(init?.body))).toEqual({
        capitalUsd: "1000",
        days: 90,
        mode: "explore",
      });
      return json({ capitalUsd: "1000.00", allocations: [] });
    });
    const client = new RiskOsClient({
      baseUrl: "https://api.example.com",
      apiKey: "rk_live_1234567890",
      credentials: "include",
      headers: { "x-tenant": "treasury" },
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.createYieldAllocation({ capitalUsd: "1000", days: 90 });
  });

  it("preserves structured problem details and request metadata", async () => {
    const client = new RiskOsClient({
      baseUrl: "https://api.example.com",
      retries: 0,
      fetch: (async () =>
        json(
          { code: "INVALID_ADDRESS", title: "Invalid address", detail: "Use a mainnet principal" },
          400,
          { "x-request-id": "req_123", "retry-after": "5" },
        )) as typeof fetch,
    });
    const error = await client.getPositions("bad").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RiskOsClientError);
    expect(error).toMatchObject({
      status: 400,
      code: "INVALID_ADDRESS",
      message: "Invalid address",
      detail: "Use a mainnet principal",
      requestId: "req_123",
      retryAfterSeconds: 5,
    });
  });

  it("retries transient GET failures but never retries POST requests", async () => {
    const getFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ code: "BUSY", title: "Busy" }, 503))
      .mockResolvedValueOnce(json({ status: "ok", dataMode: "live", execution: "advisory" }));
    const getClient = new RiskOsClient({
      baseUrl: "https://api.example.com",
      fetch: getFetch,
      retries: 1,
      retryDelayMs: 1,
    });
    await expect(getClient.health()).resolves.toMatchObject({ status: "ok" });
    expect(getFetch).toHaveBeenCalledTimes(2);

    const postFetch = vi.fn<typeof fetch>().mockResolvedValue(json({ code: "BUSY", title: "Busy" }, 503));
    const postClient = new RiskOsClient({
      baseUrl: "https://api.example.com",
      fetch: postFetch,
      retries: 3,
    });
    await expect(postClient.planRepay("SP123", "position", "1")).rejects.toMatchObject({ code: "BUSY" });
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes caller cancellation, timeout, invalid JSON, and empty responses", async () => {
    const hangingFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const timeoutClient = new RiskOsClient({
      baseUrl: "https://api.example.com",
      fetch: hangingFetch,
      timeoutMs: 5,
      retries: 0,
    });
    await expect(timeoutClient.health()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });

    const controller = new AbortController();
    const abortClient = new RiskOsClient({
      baseUrl: "https://api.example.com",
      fetch: hangingFetch,
      retries: 0,
    });
    const request = abortClient.health({ signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "REQUEST_ABORTED" });

    const invalidClient = new RiskOsClient({
      baseUrl: "https://api.example.com",
      retries: 0,
      fetch: (async () =>
        new Response("{", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
    });
    await expect(invalidClient.health()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const logoutClient = new RiskOsClient({
      baseUrl: "https://api.example.com",
      fetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
    });
    await expect(logoutClient.logoutWalletSession()).resolves.toBeUndefined();
  });
});
