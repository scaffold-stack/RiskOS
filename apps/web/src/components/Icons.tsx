export type IconName =
  | "overview"
  | "positions"
  | "risk"
  | "protect"
  | "alerts"
  | "markets"
  | "bridge"
  | "rewards"
  | "reports"
  | "team"
  | "integrations"
  | "settings"
  | "search"
  | "arrow"
  | "copy"
  | "refresh"
  | "wallet"
  | "shield"
  | "droplet"
  | "coins"
  | "link"
  | "chart"
  | "layers"
  | "check"
  | "info";

const paths: Record<IconName, string> = {
  overview: "M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z",
  positions: "M4 6h16M4 12h16M4 18h16",
  risk: "M12 3 3.5 7v5c0 5.2 3.6 8.4 8.5 10 4.9-1.6 8.5-4.8 8.5-10V7z",
  protect: "M12 2v20M5 7l7-5 7 5M5 17l7 5 7-5",
  alerts: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  markets: "M3 17l5-5 4 3 8-9M15 6h5v5",
  bridge: "M5 8h14M15 4l4 4-4 4M19 16H5M9 12l-4 4 4 4",
  rewards: "M12 8v13M8 12h8M5 8h14v13H5zM4 4h5c2 0 3 4 3 4S7 8 4 7zM20 4h-5c-2 0-3 4-3 4s5 0 8-1z",
  reports: "M5 3h10l4 4v14H5zM9 13h6M9 17h6M14 3v5h5",
  team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  integrations: "M8 3v4M16 3v4M7 7h10v5a5 5 0 0 1-10 0zM12 17v4",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V20h-3v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 6.1 15a1.7 1.7 0 0 0-1.55-1H4v-3h.55A1.7 1.7 0 0 0 6.1 10a1.7 1.7 0 0 0-.34-1.88L5.7 8.06l2.12-2.12.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1-1.55V4h3v.79a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.55 1H21v3h-.05a1.7 1.7 0 0 0-1.55 1z",
  search: "m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z",
  arrow: "M5 12h14M13 6l6 6-6 6",
  copy: "M8 8h11v12H8zM5 16H4V4h11v1",
  refresh: "M20 6v5h-5M4 18v-5h5M18.1 9A7 7 0 0 0 6.6 6.6L4 9M5.9 15A7 7 0 0 0 17.4 17.4L20 15",
  wallet: "M3 6h16v14H3zM3 9h18v7h-6a3 3 0 0 1 0-6h6M15 13h.01",
  shield: "M12 2 4 5v6c0 5.2 3.4 8.8 8 11 4.6-2.2 8-5.8 8-11V5zM8.5 12l2.2 2.2 4.8-5",
  droplet: "M12 2S5 10.2 5 15a7 7 0 0 0 14 0c0-4.8-7-13-7-13zM9 16c.5 1.4 1.5 2 3 2",
  coins: "M20 6c0 1.7-3.6 3-8 3S4 7.7 4 6s3.6-3 8-3 8 1.3 8 3zM4 6v4c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 10v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4M4 14v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4",
  link: "M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  layers: "m12 2 9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5",
  check: "M5 12.5 9.5 17 19 7.5",
  info: "M12 17v-6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
