export function ratioToDecimal(numerator: bigint, denominator: bigint, scale = 6): string | null {
  if (denominator === 0n) return null;
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const factor = 10n ** BigInt(scale);
  const value = (absoluteNumerator * factor) / absoluteDenominator;
  const whole = value / factor;
  const fraction = (value % factor).toString().padStart(scale, "0").replace(/0+$/, "");
  const magnitude = fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
  return negative && value !== 0n ? `-${magnitude}` : magnitude;
}

export function decimalToScaled(value: string, scale = 8): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal: ${value}`);
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0").slice(0, scale));
  return negative ? -result : result;
}
