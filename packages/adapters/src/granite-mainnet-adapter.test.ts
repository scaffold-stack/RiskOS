import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { registryManifestSchema } from "../../data-foundation/src/registry.js";
import { GraniteMainnetAdapter } from "./granite-mainnet-adapter.js";
import type { StacksReadOnlyClient } from "./stacks-read-only-client.js";

const owner = "SP000000000000000000002Q6VF78";
const state = "SP35E2BBMDT2Y1HB0NTK139YBGYV3PAPK3WA8BRNA.state-v1";
const collateral = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const aeUsdc = "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc";

function contractPrincipal(principal: string) {
  return Cl.contractPrincipal(...(principal.split(".") as [string, string]));
}

function manifest() {
  const entry = (overrides: Record<string, unknown>) => ({
    protocol: "granite", adapterVersion: "granite-state-v1-readonly-2026-09", network: "mainnet",
    interfaceHash: `sha256:${"a".repeat(64)}`, activationBlock: 1,
    supportedAssets: [], assetDefinitions: [], readOnlyFunctions: [], transactionFunctions: [],
    evidenceUrls: ["https://example.com/source", "https://example.com/explorer"], enabled: true,
    ...overrides,
  });
  return registryManifestSchema.parse({
    version: "2026-09-09.1", network: "mainnet",
    issuedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2027-09-09T00:00:00.000Z",
    entries: [
      entry({
        contractPrincipal: state,
        supportedAssets: ["gUSDC", "aeUSDC", "sBTC"],
        assetDefinitions: [{ assetIdentifier: `${state}::lp-token`, symbol: "gUSDC", decimals: 6, spendable: true }],
        readOnlyFunctions: ["get-user-position", "get-user-collateral", "get-collateral", "get-debt-params", "convert-to-assets", "get-balance"],
      }),
      entry({
        contractPrincipal: collateral, supportedAssets: ["sBTC"],
        assetDefinitions: [{ assetIdentifier: `${collateral}::sbtc-token`, symbol: "sBTC", decimals: 8, spendable: true }],
      }),
      entry({
        contractPrincipal: aeUsdc, supportedAssets: ["aeUSDC"],
        assetDefinitions: [{ assetIdentifier: `${aeUsdc}::aeUSDC`, symbol: "aeUSDC", decimals: 6, spendable: true }],
      }),
    ],
  });
}

describe("GraniteMainnetAdapter", () => {
  it("returns no position when Granite has no borrower state for the address", async () => {
    const client = {
      async pinTip() {
        return { blockHeight: 100, async call() { return Cl.none(); } };
      },
    } as unknown as StacksReadOnlyClient;
    await expect(new GraniteMainnetAdapter(async () => manifest(), client).discover(owner)).resolves.toEqual([]);
  });

  it("reads collateral and converts debt shares with Granite's round-up rule at one pinned block", async () => {
    const client = {
      async pinTip() {
        return {
          blockHeight: 8_952_308,
          async call(_contract: string, functionName: string) {
            if (functionName === "get-user-position") return Cl.some(Cl.tuple({
              "debt-shares": Cl.uint(100),
              collaterals: Cl.list([contractPrincipal(collateral)]),
              "borrowed-amount": Cl.uint(100),
              "borrowed-block": Cl.uint(8_900_000),
            }));
            if (functionName === "get-user-collateral") return Cl.some(Cl.tuple({ amount: Cl.uint(200_000_000) }));
            if (functionName === "get-collateral") return Cl.some(Cl.tuple({
              "max-ltv": Cl.uint(60_000_000),
              "liquidation-ltv": Cl.uint(70_000_000),
              "liquidation-premium": Cl.uint(5_000_000),
              decimals: Cl.uint(8),
            }));
            if (functionName === "get-debt-params") return Cl.tuple({
              "open-interest": Cl.uint(1_001), "total-debt-shares": Cl.uint(1_000),
            });
            throw new Error(`Unexpected ${functionName}`);
          },
        };
      },
    } as unknown as StacksReadOnlyClient;

    const positions = await new GraniteMainnetAdapter(async () => manifest(), client).discover(owner);
    expect(positions).toEqual([expect.objectContaining({
      type: "lending",
      protocol: expect.objectContaining({ id: "granite", contract: state }),
      collateral: expect.objectContaining({ asset: "sBTC", amountAtomic: "200000000", decimals: 8 }),
      debt: expect.objectContaining({ asset: "aeUSDC", amountAtomic: "101", decimals: 6 }),
      parameters: { maximumLtvBps: 6000, liquidationThresholdBps: 7000 },
      provenance: [expect.objectContaining({ source: "contract-read", blockHeight: 8_952_308 })],
      confidence: expect.objectContaining({ state: "verified" }),
    })]);
  });

  it("fails closed instead of collapsing a future multi-collateral position", async () => {
    const client = {
      async pinTip() {
        return {
          blockHeight: 100,
          async call() {
            return Cl.some(Cl.tuple({
              "debt-shares": Cl.uint(1),
              collaterals: Cl.list([contractPrincipal(collateral), contractPrincipal(aeUsdc)]),
              "borrowed-amount": Cl.uint(1), "borrowed-block": Cl.uint(1),
            }));
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    await expect(new GraniteMainnetAdapter(async () => manifest(), client).discover(owner)).rejects.toThrow("multi-collateral risk is not yet approved");
  });

  it("fails closed when debt shares cannot be reconciled to market debt totals", async () => {
    const client = {
      async pinTip() {
        return {
          blockHeight: 100,
          async call(_contract: string, functionName: string) {
            if (functionName === "get-user-position") return Cl.some(Cl.tuple({
              "debt-shares": Cl.uint(1), collaterals: Cl.list([contractPrincipal(collateral)]),
              "borrowed-amount": Cl.uint(1), "borrowed-block": Cl.uint(1),
            }));
            if (functionName === "get-user-collateral") return Cl.some(Cl.tuple({ amount: Cl.uint(1) }));
            if (functionName === "get-collateral") return Cl.some(Cl.tuple({
              "max-ltv": Cl.uint(60_000_000), "liquidation-ltv": Cl.uint(70_000_000),
              "liquidation-premium": Cl.uint(5_000_000), decimals: Cl.uint(8),
            }));
            if (functionName === "get-debt-params") return Cl.tuple({
              "open-interest": Cl.uint(0), "total-debt-shares": Cl.uint(0),
            });
            throw new Error(`Unexpected ${functionName}`);
          },
        };
      },
    } as unknown as StacksReadOnlyClient;
    await expect(new GraniteMainnetAdapter(async () => manifest(), client).discover(owner)).rejects.toThrow(
      "debt shares exist without usable market debt totals",
    );
  });
});
