import { cvToHex, hexToCV, type ClarityValue } from "@stacks/transactions";
import { z } from "zod";
import { fetchWithRateLimitRetry } from "./http-retry.js";

const latestBlockSchema = z.object({
  results: z.array(z.object({
    canonical: z.literal(true),
    height: z.number().int().nonnegative(),
    index_block_hash: z.string(),
  }).passthrough()).min(1),
}).passthrough();

const readResponseSchema = z.object({
  okay: z.boolean(),
  result: z.string().optional(),
  cause: z.string().optional(),
}).passthrough();

const interfaceSchema = z.object({ fungible_tokens: z.array(z.object({ name: z.string().min(1) })).default([]) }).passthrough();

export class StacksReadOnlyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly request: typeof fetch = fetch,
    private readonly apiKey?: string,
  ) {}

  async pinTip(): Promise<PinnedStacksReadClient> {
    const response = await fetchWithRateLimitRetry(this.request, `${this.baseUrl}/extended/v2/blocks?limit=1`, {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`Stacks tip lookup returned ${response.status}`);
    const tip = latestBlockSchema.parse(await response.json()).results[0]!;
    return new PinnedStacksReadClient(this.baseUrl, tip.height, tip.index_block_hash, this.request, this.apiKey);
  }

  async assetIdentifier(contractPrincipal: string): Promise<string> {
    const separator = contractPrincipal.indexOf(".");
    if (separator < 1) throw new Error("Asset contract principal is invalid");
    const response = await fetchWithRateLimitRetry(this.request, `${this.baseUrl}/v2/contracts/interface/${contractPrincipal.slice(0, separator)}/${contractPrincipal.slice(separator + 1)}`, {
      headers: this.headers(),
    });
    if (!response.ok) throw new Error(`Asset interface lookup returned ${response.status}`);
    const tokens = interfaceSchema.parse(await response.json()).fungible_tokens;
    const spendable = tokens.filter((token) => !token.name.toLowerCase().includes("locked"));
    if (spendable.length !== 1) throw new Error(`Expected exactly one spendable fungible token in ${contractPrincipal}`);
    return `${contractPrincipal}::${spendable[0]!.name}`;
  }

  private headers() {
    return {
      accept: "application/json",
      "user-agent": "riskos/0.1",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
  }
}

export class PinnedStacksReadClient {
  constructor(
    private readonly baseUrl: string,
    readonly blockHeight: number,
    readonly indexBlockHash: string,
    private readonly request: typeof fetch = fetch,
    private readonly apiKey?: string,
  ) {}

  async call(contractPrincipal: string, functionName: string, args: ClarityValue[]): Promise<ClarityValue> {
    const separator = contractPrincipal.indexOf(".");
    const address = contractPrincipal.slice(0, separator);
    const contract = contractPrincipal.slice(separator + 1);
    const response = await fetchWithRateLimitRetry(this.request,
      `${this.baseUrl}/v2/contracts/call-read/${address}/${contract}/${functionName}?tip=${encodeURIComponent(this.indexBlockHash)}`,
      {
        method: "POST",
        headers: {
          accept: "application/json", "content-type": "application/json", "user-agent": "riskos/0.1",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
        body: JSON.stringify({ sender: "SP000000000000000000002Q6VF78", arguments: args.map(cvToHex) }),
      },
    );
    if (!response.ok) throw new Error(`Read-only call ${functionName} returned ${response.status}`);
    const parsed = readResponseSchema.parse(await response.json());
    if (!parsed.okay || !parsed.result) throw new Error(`Read-only call ${functionName} failed: ${parsed.cause ?? "unknown cause"}`);
    return hexToCV(parsed.result);
  }
}
