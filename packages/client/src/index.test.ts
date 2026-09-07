import { describe, expect, it, vi } from "vitest";
import { RiskOsClient, RiskOsClientError } from "./index.js";

describe("RiskOsClient", () => {
  it("fetches portfolio and surfaces problem details", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok", dataMode: "live", execution: "advisory-shadow-only" }), { status: 200 });
      }
      if (url.includes("/portfolio")) {
        return new Response(JSON.stringify({ address: "SP123", headline: "demo", currency: "USD" }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "INVALID_ADDRESS", title: "Invalid", detail: "bad" }), { status: 400 });
    });
    const client = new RiskOsClient({ baseUrl: "http://localhost:3001", fetch: fetchMock as unknown as typeof fetch });
    await expect(client.health()).resolves.toMatchObject({ dataMode: "live" });
    await expect(client.getPortfolio("SP123")).resolves.toMatchObject({ headline: "demo" });
    await expect(client.getPositions("bad")).rejects.toBeInstanceOf(RiskOsClientError);
  });
});
