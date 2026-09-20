import { describe, expect, it } from "vitest";
import { DEMO_ADDRESS, FixtureZestAdapter } from "../../adapters/src/index.js";
import { evaluateRisks } from "../../risk-engine/src/index.js";
import { registryManifestSchema } from "../../data-foundation/src/registry.js";
import { planRepay, planZestMainnetRepay, walletRequestForIntent } from "./index.js";

describe("protective action planner", () => {
  it("creates only a simulated, expiring, allowlisted testnet intent", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0];
    if (!position || position.type !== "lending") throw new Error("Fixture missing");
    const now = new Date("2026-09-03T15:00:00Z");
    const risk = evaluateRisks([position], now)[0]!;
    const intent = planRepay(position, risk, "9500000000", 123_456, now);
    expect(intent).toMatchObject({
      network: "testnet",
      status: "ready",
      simulation: { status: "passed", stateBlock: 123_456 },
      calls: [{ function: "repay" }],
    });
    expect(Number(intent.simulation.postHealthFactor)).toBeGreaterThanOrEqual(1.35);
    expect(intent.warnings).toContain("TESTNET FIXTURE ONLY — this intent cannot be broadcast to mainnet");
  });

  it("builds only an integrity-checked, unexpired testnet wallet request", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0];
    if (!position || position.type !== "lending") throw new Error("fixture missing");
    const now = new Date("2026-09-03T15:00:00Z");
    const risk = evaluateRisks([position], now)[0]!;
    const intent = planRepay(position, risk, "9500000000", 123_456, now);
    expect(walletRequestForIntent(intent, now, 123_456)).toMatchObject({ mode: "testnet-wallet", params: { postConditionMode: "deny" } });
    expect(() => walletRequestForIntent({ ...intent, reason: { ...intent.reason, targetHealthFactor: "1.01" } }, now, 123_456)).toThrow(/integrity/);
    expect(() => walletRequestForIntent(intent, new Date("2026-09-03T15:02:00Z"), 123_456)).toThrow(/expired/);
  });

  it("blocks a plan that does not achieve the configured target health", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0];
    if (!position || position.type !== "lending") throw new Error("Fixture missing");
    const risk = evaluateRisks([position])[0]!;
    expect(planRepay(position, risk, "500000000", 123_456).status).toBe("blocked");
  });
});

describe("Zest mainnet repayment shadow", () => {
  it("builds the deployed three-argument call and a deny-mode spend cap", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0];
    if (!position || position.type !== "lending") throw new Error("fixture missing");
    const market = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-8-market";
    const debtContract = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
    const now = new Date("2026-09-04T12:00:00Z");
    const live = { ...position, protocol: { id: "zest", version: "zest-v2-v0.8-repay-shadow-2026-09", contract: market }, debt: {
      ...position.debt, valueUsd: null, amountAtomic: "100000000", protocolAssetId: 2,
      contractPrincipal: debtContract, assetIdentifier: `${debtContract}::sbtc-token`,
    }, collateral: { ...position.collateral, valueUsd: null },
      provenance: [{ source: "contract-read" as const, blockHeight: 900, observedAt: now.toISOString() }],
      confidence: { state: "verified" as const, score: 0.92, reasons: ["Pinned contract read"] },
    };
    const manifest = registryManifestSchema.parse({ version: "2026-09-04.1", network: "mainnet", issuedAt: now.toISOString(), expiresAt: "2026-10-04T00:00:00Z", entries: [{
      protocol: "zest-v2", adapterVersion: live.protocol.version, network: "mainnet", contractPrincipal: market,
      interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1, supportedAssets: ["sBTC"], readOnlyFunctions: [], transactionFunctions: ["repay"],
      evidenceUrls: ["https://zest.example/source", "https://explorer.example/deploy"], enabled: true,
    }] });
    const intent = planZestMainnetRepay(DEMO_ADDRESS, live, evaluateRisks([live], now)[0]!, "100000000", 900, manifest, now);
    expect(intent).toMatchObject({ network: "mainnet", status: "ready", executionMode: "shadow", calls: [{ function: "repay", args: expect.arrayContaining([expect.stringMatching(/^0x/)]) }] });
    expect(intent.calls[0]?.args).toHaveLength(3);
    expect(intent.calls[0]?.postConditions[0]).toMatchObject({ type: "ft-postcondition", condition: "lte", amount: "100000000" });
    expect(walletRequestForIntent(intent, now, 900)).toMatchObject({ mode: "shadow", params: null });
  });

  it("blocks unpriced partial repayment", async () => {
    const position = (await new FixtureZestAdapter().discover(DEMO_ADDRESS))[0];
    if (!position || position.type !== "lending") throw new Error("fixture missing");
    const live = { ...position, debt: { ...position.debt, valueUsd: null }, collateral: { ...position.collateral, valueUsd: null } };
    expect(planZestMainnetRepay(DEMO_ADDRESS, live, evaluateRisks([live])[0]!, "1", 1, null).status).toBe("blocked");
  });
});
