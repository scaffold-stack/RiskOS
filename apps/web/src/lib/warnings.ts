/** Notices that belong in headline/footer copy, not alarming provider banners. */
const QUIET_WARNING_PATTERNS = [
  /exact portfolio totals are suppressed/i,
  /btc reference price is unavailable/i,
  /using unsigned candidate registry/i,
  /hiro api key is not configured/i,
  /independent stacks reference provider/i,
  /no active registry manifest/i,
  /live mode received fixture/i,
  /stacks block provenance is unavailable/i,
  /yield-rate enrichment degraded/i,
];

/** Keep adapter/price failures visible; drop expected integrity and env advisories. */
export function operationalWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)].filter(
    (warning) => !QUIET_WARNING_PATTERNS.some((pattern) => pattern.test(warning)),
  );
}
