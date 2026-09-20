import { describe, expect, it } from "vitest";

import { compactAssetLabel, healthFactorLabel } from "./RiskPage.js";

describe("compactAssetLabel", () => {
  it("uses the token name for a fully qualified SIP-010 asset", () => {
    expect(compactAssetLabel("SP37WN2BYHKZ9OT1ATHTCNG8EFYHS3B49KNGSO2ZK.RALEX::RALEX")).toBe("RALEX");
  });

  it("leaves readable position pairs unchanged", () => {
    expect(compactAssetLabel("zsBTC / USDCx")).toBe("zsBTC / USDCx");
  });
});

describe("healthFactorLabel", () => {
  it("states the liquidation boundary without implying absolute safety", () => {
    expect(healthFactorLabel("1.0000")).toBe("At or beyond the liquidation boundary");
    expect(healthFactorLabel("1.0800")).toBe("Very small safety buffer");
  });

  it("interprets the RiskOS monitoring target", () => {
    expect(healthFactorLabel("1.2000")).toBe("Below the RiskOS monitoring target");
    expect(healthFactorLabel("1.3575")).toBe("Above target, with a moderate buffer");
    expect(healthFactorLabel("2.0000")).toBe("Above target, with a stronger buffer");
  });

  it("fails closed when the value cannot be interpreted", () => {
    expect(healthFactorLabel(null)).toBe("Cannot be interpreted without complete valuations");
    expect(healthFactorLabel("unknown")).toBe("Cannot be interpreted without complete valuations");
  });
});
