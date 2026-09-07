import type { IconName } from "../components/Icons.js";
import { EmptyState, PageHeader, Panel, StatusChip } from "../components/Ui.js";

type ScopedRoute = "markets" | "rewards" | "reports" | "team" | "settings";

const content: Record<ScopedRoute, { title: string; description: string; icon: IconName; scope: string }> = {
  markets: {
    title: "Markets & liquidity",
    description: "Read-only visibility into supported protocol routes and exit conditions.",
    icon: "markets",
    scope:
      "Market-wide discovery is deferred. The MVP currently resolves only positions owned by the inspected address — see Positions and Risk for live mainnet exposure.",
  },
  rewards: {
    title: "Rewards",
    description: "Protocol incentives tied to inspected positions.",
    icon: "rewards",
    scope:
      "Reward accrual surfaces are deferred until adapters expose claimable balances with provenance. Live yield meaning currently appears in Overview earning answers.",
  },
  reports: {
    title: "Reports",
    description: "Auditable position, provenance, and risk evidence exports.",
    icon: "reports",
    scope:
      "Signed and scheduled report generation is deferred. Current API responses remain available for direct evidence capture.",
  },
  team: {
    title: "Team",
    description: "Shared treasury roles and approval policies.",
    icon: "team",
    scope:
      "Multi-signer treasury workflows are out of MVP scope. Wallet ownership today is single-session authentication for alerts and protect review.",
  },
  settings: {
    title: "Settings",
    description: "Data-source, policy, and portfolio configuration.",
    icon: "settings",
    scope:
      "Account persistence is not enabled. Runtime source configuration remains deployment-managed for the production MVP.",
  },
};

export function ScopedPage({ route }: { route: ScopedRoute }) {
  const page = content[route];
  return (
    <>
      <PageHeader title={page.title} description={page.description} />
      <Panel title="MVP release boundary" meta="Visible by design">
        <div className="scoped-empty">
          <EmptyState
            title="Interface reserved"
            description={page.scope}
            action={<StatusChip tone="uncertain">deferred scope</StatusChip>}
          />
        </div>
      </Panel>
    </>
  );
}
