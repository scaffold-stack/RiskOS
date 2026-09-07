const protocolArtwork = {
  bitflow: "/assets/protocols/bitflow.svg",
  bitcoin: "/assets/tokens/btc.png",
  sbtc: "/assets/protocols/sbtc.png",
  stacks: "/assets/protocols/stacks.png",
  stackingdao: "/assets/protocols/stackingdao.svg",
  zest: "/assets/protocols/zest.png",
} as const;

export function ProtocolIcon({ protocol, size = 28 }: { protocol: string; size?: number }) {
  const key = protocolKey(protocol);
  if (!key) {
    return <span className="protocol-icon-fallback" style={{ width: size, height: size }}>{protocol.slice(0, 2).toUpperCase()}</span>;
  }
  return <img className="protocol-icon-image" src={protocolArtwork[key]} width={size} height={size} alt={`${protocolName(key)} protocol`} />;
}

function protocolKey(protocol: string): keyof typeof protocolArtwork | null {
  const normalized = protocol.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.includes("bitflow")) return "bitflow";
  if (normalized === "bitcoin" || normalized === "btc") return "bitcoin";
  if (normalized.includes("stackingdao")) return "stackingdao";
  if (normalized.includes("zest")) return "zest";
  if (normalized.includes("sbtc")) return "sbtc";
  if (normalized.includes("stacks")) return "stacks";
  return null;
}

function protocolName(key: keyof typeof protocolArtwork) {
  return key === "sbtc" ? "sBTC" : key === "stackingdao" ? "StackingDAO" : key[0]!.toUpperCase() + key.slice(1);
}
