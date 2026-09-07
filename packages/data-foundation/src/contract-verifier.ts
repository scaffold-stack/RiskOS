import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import type { RegistryManifest } from "./registry.js";

const interfaceSchema = z.object({
  functions: z.array(z.object({
    name: z.string(),
    access: z.enum(["private", "public", "read_only"]),
  }).passthrough()),
}).passthrough();

const deploymentSchema = z.object({
  tx_id: z.string().regex(/^0x[a-f0-9]{64}$/),
  canonical: z.boolean(),
  contract_id: z.string(),
  block_height: z.number().int().nonnegative(),
}).passthrough();

export interface ContractVerificationResult {
  contractPrincipal: string;
  interfaceHash: string;
  activationBlock: number;
  deploymentTransactionId: string;
  valid: boolean;
  errors: string[];
}

export class ContractRegistryVerifier {
  constructor(
    private readonly baseUrl: string,
    private readonly request: typeof fetch = fetch,
    private readonly apiKey?: string,
  ) {}

  async verifyManifest(manifest: RegistryManifest): Promise<ContractVerificationResult[]> {
    const results: ContractVerificationResult[] = [];
    // Keep verification deliberately low-volume so an activation cannot amplify
    // into an upstream burst or become dependent on a high paid rate limit.
    for (const entry of manifest.entries) results.push(await this.verifyEntry(entry));
    return results;
  }

  async verifyEntry(entry: RegistryManifest["entries"][number]): Promise<ContractVerificationResult> {
    const separator = entry.contractPrincipal.indexOf(".");
    const address = entry.contractPrincipal.slice(0, separator);
    const contractName = entry.contractPrincipal.slice(separator + 1);
    const headers = {
      accept: "application/json",
      "user-agent": "riskos/0.1",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
    const [interfaceResponse, deploymentResponse] = await Promise.all([
      this.request(`${this.baseUrl}/v2/contracts/interface/${address}/${contractName}`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      }),
      this.request(`${this.baseUrl}/extended/v1/contract/${entry.contractPrincipal}`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      }),
    ]);
    if (!interfaceResponse.ok) throw new Error(`Contract interface lookup returned ${interfaceResponse.status}`);
    if (!deploymentResponse.ok) throw new Error(`Contract deployment lookup returned ${deploymentResponse.status}`);

    const contractInterface = interfaceSchema.parse(await interfaceResponse.json());
    const deployment = deploymentSchema.parse(await deploymentResponse.json());
    const interfaceHash = `sha256:${createHash("sha256").update(canonicalJson(contractInterface)).digest("hex")}`;
    const functions = new Map(contractInterface.functions.map((fn) => [fn.name, fn.access]));
    const errors: string[] = [];
    if (!deployment.canonical) errors.push("deployment is not canonical");
    if (deployment.contract_id !== entry.contractPrincipal) errors.push("deployment principal does not match");
    if (deployment.block_height !== entry.activationBlock) errors.push(`activation block is ${deployment.block_height}`);
    if (entry.deploymentTransactionId && deployment.tx_id !== entry.deploymentTransactionId) errors.push(`deployment transaction is ${deployment.tx_id}`);
    if (interfaceHash !== entry.interfaceHash) errors.push(`interface hash is ${interfaceHash}`);
    for (const name of entry.readOnlyFunctions) {
      if (functions.get(name) !== "read_only") errors.push(`${name} is not a deployed read-only function`);
    }
    for (const name of entry.transactionFunctions) {
      if (functions.get(name) !== "public") errors.push(`${name} is not a deployed public function`);
    }
    return {
      contractPrincipal: entry.contractPrincipal,
      interfaceHash,
      activationBlock: deployment.block_height,
      deploymentTransactionId: deployment.tx_id,
      valid: errors.length === 0,
      errors,
    };
  }
}
