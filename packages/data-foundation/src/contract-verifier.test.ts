import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { ContractRegistryVerifier } from "./contract-verifier.js";

describe("ContractRegistryVerifier", () => {
  it("checks canonical deployment, interface hash, activation block, and function access", async () => {
    const contractInterface = {
      functions: [
        { name: "get-balance", access: "read_only", args: [], outputs: { type: "uint128" } },
        { name: "transfer", access: "public", args: [], outputs: { type: "bool" } },
      ],
      variables: [], maps: [], fungible_tokens: [], non_fungible_tokens: [],
    };
    const interfaceHash = `sha256:${createHash("sha256").update(canonicalJson(contractInterface)).digest("hex")}`;
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).includes("/interface/")
        ? contractInterface
        : { tx_id: `0x${"a".repeat(64)}`, canonical: true, contract_id: "SP000000000000000000002Q6VF78.token", block_height: 42 },
    ), { status: 200, headers: { "content-type": "application/json" } }));
    const verifier = new ContractRegistryVerifier("https://example.test", request);
    const result = await verifier.verifyEntry({
      protocol: "test",
      adapterVersion: "1",
      network: "mainnet",
      contractPrincipal: "SP000000000000000000002Q6VF78.token",
      interfaceHash,
      activationBlock: 42,
      supportedAssets: [],
      assetDefinitions: [],
      readOnlyFunctions: ["get-balance"],
      transactionFunctions: ["transfer"],
      evidenceUrls: ["https://protocol.test/deployment", "https://explorer.test/tx"],
      enabled: true,
    });
    expect(result).toMatchObject({ valid: true, errors: [], activationBlock: 42, interfaceHash });
  });

  it("fails closed when a declared function or deployment fact changed", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).includes("/interface/")
        ? { functions: [{ name: "get-balance", access: "public" }] }
        : { tx_id: `0x${"b".repeat(64)}`, canonical: false, contract_id: "SP000000000000000000002Q6VF78.token", block_height: 43 },
    ), { status: 200 }));
    const result = await new ContractRegistryVerifier("https://example.test", request).verifyEntry({
      protocol: "test", adapterVersion: "1", network: "mainnet",
      contractPrincipal: "SP000000000000000000002Q6VF78.token",
      interfaceHash: `sha256:${"0".repeat(64)}`,
      activationBlock: 42,
      supportedAssets: [], assetDefinitions: [], readOnlyFunctions: ["get-balance"], transactionFunctions: [],
      evidenceUrls: ["https://protocol.test/deployment", "https://explorer.test/tx"], enabled: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "deployment is not canonical",
      "activation block is 43",
      "get-balance is not a deployed read-only function",
    ]));
  });
});
