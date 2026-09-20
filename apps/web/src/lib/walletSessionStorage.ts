const WALLET_SESSION_STORAGE_KEY = "riskosfolio:wallet-session:v1";

export interface PersistedWalletSession {
  token: string;
  expiresAt: string;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readWalletSessionToken(
  storage: SessionStorageLike | null,
  nowMs = Date.now(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(WALLET_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedWalletSession>;
    if (
      typeof value.token !== "string" ||
      value.token.length < 32 ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= nowMs
    ) {
      storage.removeItem(WALLET_SESSION_STORAGE_KEY);
      return null;
    }
    return value.token;
  } catch {
    storage.removeItem(WALLET_SESSION_STORAGE_KEY);
    return null;
  }
}

export function writeWalletSession(
  storage: SessionStorageLike | null,
  session: PersistedWalletSession,
): void {
  if (!storage) return;
  storage.setItem(WALLET_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearWalletSession(storage: SessionStorageLike | null): void {
  storage?.removeItem(WALLET_SESSION_STORAGE_KEY);
}
