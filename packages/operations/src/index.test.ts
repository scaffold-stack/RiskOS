import { describe, expect, it } from "vitest";
import {
  AdminSessionService,
  MemoryAdminAnalyticsStore,
  createAdminPasswordVerifier,
  verifyAdminPassword,
} from "./index.js";

describe("admin operations foundation", () => {
  it("uses a salted scrypt verifier and short-lived opaque sessions", async () => {
    const verifier = await createAdminPasswordVerifier("correct-horse-battery-staple");
    expect(verifier).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifier).not.toContain("correct-horse-battery-staple");
    expect(await verifyAdminPassword("wrong-password", verifier)).toBe(false);
    expect(await verifyAdminPassword("correct-horse-battery-staple", verifier)).toBe(true);

    const now = new Date("2026-09-21T08:00:00.000Z");
    const sessions = new AdminSessionService(verifier, 60_000);
    expect(await sessions.login("wrong-password", now)).toBeNull();
    const session = await sessions.login("correct-horse-battery-staple", now);
    expect(session?.token).toHaveLength(43);
    expect(sessions.authenticate(session?.token ?? null, now)).toBe(true);
    expect(
      sessions.authenticate(session?.token ?? null, new Date(now.getTime() + 60_001)),
    ).toBe(false);
  });

  it("aggregates privacy-preserving request and adoption activity", async () => {
    const store = new MemoryAdminAnalyticsStore();
    await store.recordRequest({
      requestId: "one",
      method: "GET",
      route: "/v1/address/:address/overview",
      statusCode: 200,
      durationMs: 120,
      actorKind: "anonymous",
      apiKeyId: null,
      addressHash: "a".repeat(64),
      eventKind: "address-search",
      occurredAt: "2026-09-21T07:30:00.000Z",
    });
    await store.recordRequest({
      requestId: "two",
      method: "GET",
      route: "/v1/address/:address/overview",
      statusCode: 502,
      durationMs: 300,
      actorKind: "api-key",
      apiKeyId: "key_one",
      addressHash: null,
      eventKind: "api-request",
      occurredAt: "2026-09-21T07:40:00.000Z",
    });
    const snapshot = await store.snapshot("24h", new Date("2026-09-21T08:00:00.000Z"));
    expect(snapshot.traffic).toMatchObject({
      requests: 2,
      errors: 1,
      addressSearches: 1,
      uniqueAddresses: 1,
    });
    expect(snapshot.endpoints[0]).toMatchObject({ requests: 2, errors: 1 });
    expect(snapshot.recentActivity).toHaveLength(2);
  });
});
