import { describe, expect, it } from "vitest";
import {
  clearWalletSession,
  readWalletSessionToken,
  writeWalletSession,
} from "./walletSessionStorage.js";

class MemorySessionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("wallet session storage", () => {
  it("restores a valid tab-scoped wallet token after a reload", () => {
    const storage = new MemorySessionStorage();
    writeWalletSession(storage, {
      token: "wallet-token-that-is-long-enough-to-be-valid",
      expiresAt: "2026-09-20T13:00:00.000Z",
    });
    expect(readWalletSessionToken(storage, Date.parse("2026-09-20T12:30:00.000Z"))).toBe(
      "wallet-token-that-is-long-enough-to-be-valid",
    );
  });

  it("rejects and removes expired, malformed, or short tokens", () => {
    const storage = new MemorySessionStorage();
    writeWalletSession(storage, {
      token: "wallet-token-that-is-long-enough-to-be-valid",
      expiresAt: "2026-09-20T12:00:00.000Z",
    });
    expect(readWalletSessionToken(storage, Date.parse("2026-09-20T12:00:00.000Z"))).toBeNull();

    storage.setItem("riskosfolio:wallet-session:v1", "{");
    expect(readWalletSessionToken(storage)).toBeNull();

    writeWalletSession(storage, { token: "short", expiresAt: "2026-09-21T12:00:00.000Z" });
    expect(readWalletSessionToken(storage, Date.parse("2026-09-20T12:00:00.000Z"))).toBeNull();
  });

  it("clears the persisted session on logout or authentication rejection", () => {
    const storage = new MemorySessionStorage();
    writeWalletSession(storage, {
      token: "wallet-token-that-is-long-enough-to-be-valid",
      expiresAt: "2026-09-20T13:00:00.000Z",
    });
    clearWalletSession(storage);
    expect(readWalletSessionToken(storage, Date.parse("2026-09-20T12:30:00.000Z"))).toBeNull();
  });
});
