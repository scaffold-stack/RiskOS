import { randomUUID } from "node:crypto";
import { verifyMessageSignature, verifyMessageSignatureRsv } from "@stacks/encryption";
import { getAddressFromPublicKey } from "@stacks/transactions";
import type { WalletChallenge, WalletSessionView } from "../../domain/src/index.js";
import { randomToken, tokenHash, type ProductStore, type StoredSession } from "../../workflows/src/index.js";

type Network = "mainnet" | "testnet";

export class WalletAuthService {
  constructor(
    private readonly store: ProductStore,
    private readonly network: Network,
    private readonly audience: string,
    private readonly allowFixtureProof = false,
  ) {}

  async challenge(address: string, now: Date): Promise<WalletChallenge> {
    const challengeId = `wch_${randomUUID()}`;
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const nonce = randomToken();
    const message = [
      "RiskOS wallet verification",
      `Domain: ${this.audience}`,
      `Address: ${address}`,
      `Network: ${this.network}`,
      `Nonce: ${nonce}`,
      `Expires: ${expiresAt}`,
      "This request does not authorize a transaction or transfer funds.",
    ].join("\n");
    await this.store.putChallenge({ challengeId, address, network: this.network, message, expiresAt, consumedAt: null });
    return { challengeId, address, message, expiresAt };
  }

  async verify(input: { challengeId: string; address: string; publicKey: string; signature: string }, now: Date): Promise<{ token: string; session: WalletSessionView }> {
    const challenge = await this.store.consumeChallenge(input.challengeId, now);
    if (!challenge || challenge.address !== input.address || challenge.network !== this.network) throw new Error("Challenge is invalid, expired, or already used");
    const fixtureValid = this.allowFixtureProof && input.publicKey === "fixture" && input.signature === `fixture:${challenge.challengeId}`;
    let cryptographicValid = false;
    if (!fixtureValid) {
      try {
        const derivedAddress = getAddressFromPublicKey(input.publicKey, this.network);
        cryptographicValid = derivedAddress === input.address && (
          verifyMessageSignatureRsv({ message: challenge.message, publicKey: input.publicKey, signature: input.signature })
          || verifyMessageSignature({ message: challenge.message, publicKey: input.publicKey, signature: input.signature })
        );
      } catch {
        cryptographicValid = false;
      }
    }
    if (!fixtureValid && !cryptographicValid) throw new Error("Wallet signature does not prove control of this address");
    const token = randomToken();
    const session: StoredSession = {
      tokenHash: tokenHash(token), address: input.address, network: this.network,
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    };
    await this.store.putSession(session);
    return { token, session: { address: session.address, expiresAt: session.expiresAt } };
  }

  async authenticate(token: string | null, now: Date): Promise<StoredSession | null> {
    if (!token) return null;
    return this.store.session(tokenHash(token), now);
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.store.revokeSession(tokenHash(token));
  }
}

export function sessionTokenFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const authorization = typeof headers.authorization === "string" ? headers.authorization : undefined;
  const cookieHeader = typeof headers.cookie === "string" ? headers.cookie : undefined;
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const cookie = cookieHeader?.split(";").map((value) => value.trim()).find((value) => value.startsWith("riskos_session="));
  return cookie ? decodeURIComponent(cookie.slice("riskos_session=".length)) : null;
}

export function sessionCookie(token: string, expiresAt: string, secure: boolean): string {
  return `riskos_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${secure ? "; Secure" : ""}`;
}

export function expiredSessionCookie(secure: boolean): string {
  return `riskos_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
