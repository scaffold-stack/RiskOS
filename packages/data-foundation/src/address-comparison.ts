import { createHash, randomUUID } from "node:crypto";
import type { Position } from "../../domain/src/index.js";
import { positionSchema, stacksAddressSchema } from "../../domain/src/index.js";
import { canonicalJson } from "./canonical-json.js";

export interface AddressPositionSource {
  positions(address: string): Promise<Position[]>;
}

export interface AddressComparisonResult {
  address: string;
  matched: boolean;
  candidateDigest: string;
  referenceDigest: string;
  candidate: Position[];
  reference: Position[];
}

export interface AddressComparisonRun {
  runId: string;
  addressCount: number;
  matchedCount: number;
  mismatchCount: number;
  passed: boolean;
  results: AddressComparisonResult[];
}

export function comparablePositions(positions: Position[]): unknown {
  return positions.map((position) => positionSchema.parse(position)).map((position) => {
    const { provenance: _provenance, confidence: _confidence, ...stable } = position;
    return stable;
  }).sort((left, right) => left.id.localeCompare(right.id));
}

export function comparisonDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function runAddressComparisonGate(
  addresses: readonly string[],
  candidate: AddressPositionSource,
  reference: AddressPositionSource,
): Promise<AddressComparisonRun> {
  const unique = [...new Set(addresses.map((address) => stacksAddressSchema.parse(address)))];
  if (unique.length < 100) throw new Error(`The production comparison gate requires at least 100 unique addresses; received ${unique.length}`);
  const results: AddressComparisonResult[] = [];
  for (const address of unique) {
    const [candidatePositions, referencePositions] = await Promise.all([candidate.positions(address), reference.positions(address)]);
    const candidateDigest = comparisonDigest(comparablePositions(candidatePositions));
    const referenceDigest = comparisonDigest(comparablePositions(referencePositions));
    results.push({ address, matched: candidateDigest === referenceDigest, candidateDigest, referenceDigest, candidate: candidatePositions, reference: referencePositions });
  }
  const matchedCount = results.filter((result) => result.matched).length;
  return {
    runId: randomUUID(), addressCount: unique.length, matchedCount,
    mismatchCount: results.length - matchedCount, passed: matchedCount === results.length, results,
  };
}

export class RiskOsHttpPositionSource implements AddressPositionSource {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = fetch) {}

  async positions(address: string): Promise<Position[]> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/v1/address/${encodeURIComponent(address)}/positions`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Position source ${this.baseUrl} returned HTTP ${response.status}`);
    const body = await response.json() as { positions?: unknown[] };
    return (body.positions ?? []).map((position) => positionSchema.parse(position));
  }
}

/** In-process discover callback — used for adapter self-consistency / API dual-path gates. */
export class CallbackPositionSource implements AddressPositionSource {
  constructor(private readonly discover: (address: string) => Promise<Position[]>) {}

  positions(address: string): Promise<Position[]> {
    return this.discover(address);
  }
}
