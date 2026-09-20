const tokenArtwork = {
  btc: "/assets/tokens/btc.png",
  sbtc: "/assets/tokens/sbtc.png",
  stbtc: "/assets/tokens/stbtc.png",
  ststx: "/assets/tokens/ststx.png",
  ststxbtc: "/assets/tokens/ststxbtc.png",
  stx: "/assets/tokens/stx.png",
  usdcx: "/assets/tokens/usdcx.png",
  usdh: "/assets/tokens/usdh.png",
  zsbtc: "/assets/tokens/zsbtc.png",
  zststx: "/assets/tokens/zststx.png",
  zststxbtc: "/assets/tokens/zststxbtc.png",
  zstx: "/assets/tokens/zstx.png",
  zusdcx: "/assets/tokens/zusdcx.png",
  zusdh: "/assets/tokens/zusdh.png",
} as const;

export function AssetIcon({ asset, size = 32 }: { asset: string; size?: number }) {
  const key = artworkKey(asset);
  if (!key) return <span className="asset-icon-fallback" style={{ width: size, height: size }}>{asset.slice(0, 2).toUpperCase()}</span>;
  return <img className="asset-icon-image" src={tokenArtwork[key]} width={size} height={size} alt={`${displayName(key)} token`} />;
}

function artworkKey(asset: string): keyof typeof tokenArtwork | null {
  const normalized = assetIdentifierName(asset).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("zvstbtc")) return "stbtc";
  if (normalized.includes("zststxbtc")) return "zststxbtc";
  if (normalized.includes("zststx")) return "zststx";
  if (normalized.includes("zsbtc")) return "zsbtc";
  if (normalized.includes("zusdc")) return "zusdcx";
  if (normalized.includes("zusdh")) return "zusdh";
  if (normalized.includes("zstx")) return "zstx";
  if (normalized.includes("usdc")) return "usdcx";
  if (normalized.includes("usdh")) return "usdh";
  if (normalized.includes("ststxbtc")) return "ststxbtc";
  if (normalized.includes("stbtc")) return "stbtc";
  if (normalized.includes("ststx")) return "ststx";
  if (normalized.includes("sbtc")) return "sbtc";
  if (normalized === "btc" || normalized.includes("bitcoin")) return "btc";
  if (normalized.includes("stx")) return "stx";
  return null;
}

function displayName(key: keyof typeof tokenArtwork) {
  const labels: Record<keyof typeof tokenArtwork, string> = {
    btc: "BTC", sbtc: "sBTC", stbtc: "stBTC", ststx: "stSTX",
    ststxbtc: "stSTXbtc", stx: "STX", usdcx: "USDCx", usdh: "USDh",
    zsbtc: "zsBTC", zststx: "zstSTX", zststxbtc: "zstSTXbtc",
    zstx: "zSTX", zusdcx: "zUSDCx", zusdh: "zUSDh",
  };
  return labels[key];
}

function assetIdentifierName(asset: string) {
  return asset.includes("::") ? asset.split("::").at(-1) ?? asset : asset;
}
