import {
  ClarityType,
  type ClarityValue,
  type ListCV,
  type ResponseErrorCV,
  type ResponseOkCV,
  type TupleCV,
  type UIntCV,
} from "@stacks/transactions";

export function unwrapOk(value: ClarityValue): ClarityValue {
  if (value.type !== ClarityType.ResponseOk) throw new Error("Expected an ok Clarity response");
  return (value as ResponseOkCV).value;
}

export function responseErrorUint(value: ClarityValue): bigint | null {
  if (value.type !== ClarityType.ResponseErr) return null;
  return asUint((value as ResponseErrorCV).value);
}

export function asUint(value: ClarityValue): bigint {
  if (value.type !== ClarityType.UInt) throw new Error("Expected a Clarity uint");
  return BigInt((value as UIntCV).value);
}

export function asBool(value: ClarityValue): boolean {
  if (value.type === ClarityType.BoolTrue) return true;
  if (value.type === ClarityType.BoolFalse) return false;
  throw new Error("Expected a Clarity bool");
}

export function asTuple(value: ClarityValue): Record<string, ClarityValue> {
  if (value.type !== ClarityType.Tuple) throw new Error("Expected a Clarity tuple");
  return (value as TupleCV).value;
}

export function asList(value: ClarityValue): ClarityValue[] {
  if (value.type !== ClarityType.List) throw new Error("Expected a Clarity list");
  return (value as ListCV).value;
}

export function asOptional(value: ClarityValue): ClarityValue | null {
  if (value.type === ClarityType.OptionalNone) return null;
  if (value.type !== ClarityType.OptionalSome) throw new Error("Expected a Clarity optional");
  return value.value;
}

export function tupleField(tuple: Record<string, ClarityValue>, name: string): ClarityValue {
  const value = tuple[name];
  if (!value) throw new Error(`Clarity tuple is missing ${name}`);
  return value;
}

export function bufferToUint(value: ClarityValue): number {
  if (value.type !== ClarityType.Buffer) throw new Error("Expected a Clarity buffer");
  const result = Number.parseInt(value.value || "0", 16);
  if (!Number.isSafeInteger(result)) throw new Error("Clarity buffer does not fit a safe integer");
  return result;
}

export function asPrincipal(value: ClarityValue): string {
  if (value.type !== ClarityType.PrincipalStandard && value.type !== ClarityType.PrincipalContract) {
    throw new Error("Expected a Clarity principal");
  }
  return value.value;
}

export function asText(value: ClarityValue): string {
  if (value.type !== ClarityType.StringASCII && value.type !== ClarityType.StringUTF8) {
    throw new Error("Expected a Clarity string");
  }
  return value.value;
}
