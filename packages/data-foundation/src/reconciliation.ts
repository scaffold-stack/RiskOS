import { z } from "zod";
import type { DataFoundationStore } from "./store.js";

const hiroBlockSchema = z.object({
  canonical: z.boolean(),
  height: z.number().int().nonnegative(),
  hash: z.string(),
  index_block_hash: z.string(),
  parent_index_block_hash: z.string(),
  burn_block_height: z.number().int().nonnegative(),
}).passthrough();

export interface ReconciliationResult {
  state: "green" | "amber" | "red";
  height: number;
  localIndexBlockHash: string | null;
  remoteIndexBlockHash: string | null;
  detail: string;
}

export class StacksBlockReconciler {
  constructor(
    private readonly store: DataFoundationStore,
    private readonly baseUrl: string,
    private readonly request: typeof fetch = fetch,
    private readonly apiKey?: string,
  ) {}

  async reconcile(network: "mainnet" | "testnet", height: number): Promise<ReconciliationResult> {
    const local = await this.store.canonicalBlock(network, height);
    try {
      const response = await this.request(`${this.baseUrl}/extended/v2/blocks/${height}`, {
        headers: {
          accept: "application/json",
          "user-agent": "riskos/0.1",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`Stacks API returned ${response.status}`);
      const remote = hiroBlockSchema.parse(await response.json());
      const state = !local ? "amber" : local.indexBlockHash === remote.index_block_hash && remote.canonical ? "green" : "red";
      const detail = !local
        ? "Canonical block is missing locally"
        : state === "green" ? "Local and remote canonical block hashes agree" : "Canonical block hash disagreement";
      await this.store.updateSourceHealth({ sourceId: "hiro-stacks-api", state, observedHeight: remote.height, lagBlocks: null, detail, success: true });
      return { state, height, localIndexBlockHash: local?.indexBlockHash ?? null, remoteIndexBlockHash: remote.index_block_hash, detail };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown reconciliation failure";
      await this.store.updateSourceHealth({ sourceId: "hiro-stacks-api", state: "red", observedHeight: null, lagBlocks: null, detail, success: false });
      return { state: "red", height, localIndexBlockHash: local?.indexBlockHash ?? null, remoteIndexBlockHash: null, detail };
    }
  }
}
