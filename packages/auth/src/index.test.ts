import { describe, expect, it } from "vitest";
import { hashMessage } from "@stacks/encryption";
import { getAddressFromPrivateKey, privateKeyToPublic, publicKeyToHex, randomPrivateKey, signMessageHashRsv } from "@stacks/transactions";
import { MemoryProductStore } from "../../workflows/src/index.js";
import { WalletAuthService } from "./index.js";

describe("wallet challenge authentication", () => {
  it("verifies a Stacks signed message, binds the address, and consumes the nonce once", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const privateKey = randomPrivateKey();
    const publicKey = publicKeyToHex(privateKeyToPublic(privateKey));
    const address = getAddressFromPrivateKey(privateKey, "testnet");
    const service = new WalletAuthService(new MemoryProductStore(), "testnet", "https://riskos.example");
    const challenge = await service.challenge(address, now);
    expect(challenge.message).toContain("This request does not authorize a transaction");
    const signature = signMessageHashRsv({ messageHash: Buffer.from(hashMessage(challenge.message)).toString("hex"), privateKey });
    const verified = await service.verify({ challengeId: challenge.challengeId, address, publicKey, signature }, now);
    expect(await service.authenticate(verified.token, now)).toMatchObject({ address, network: "testnet" });
    await expect(service.verify({ challengeId: challenge.challengeId, address, publicKey, signature }, now)).rejects.toThrow(/already used/);
  });

  it("rejects a proof whose key does not control the challenged address", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const ownerKey = randomPrivateKey();
    const attackerKey = randomPrivateKey();
    const address = getAddressFromPrivateKey(ownerKey, "mainnet");
    const service = new WalletAuthService(new MemoryProductStore(), "mainnet", "https://riskos.example");
    const challenge = await service.challenge(address, now);
    const signature = signMessageHashRsv({ messageHash: Buffer.from(hashMessage(challenge.message)).toString("hex"), privateKey: attackerKey });
    await expect(service.verify({ challengeId: challenge.challengeId, address, publicKey: publicKeyToHex(privateKeyToPublic(attackerKey)), signature }, now)).rejects.toThrow(/does not prove/);
  });
});
