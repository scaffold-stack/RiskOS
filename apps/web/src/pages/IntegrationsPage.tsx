import { RiskOsWidget } from "../../../../packages/widget/src/index.js";
import { PageHeader, Panel } from "../components/Ui.js";

export function IntegrationsPage({
  address,
  apiBaseUrl,
  onProtect,
}: {
  address: string;
  apiBaseUrl: string;
  onProtect: () => void;
}) {
  return (
    <>
      <PageHeader
        title="Distribution / embed"
        description="Module 4 — wallets and protocols embed positions, severity, and an advisory protect CTA without rebuilding RiskOS."
      />
      <div className="two-column primary-layout">
        <Panel title="Embedded widget preview" meta="Stacks brand tokens · advisory execution">
          <RiskOsWidget
            apiBaseUrl={apiBaseUrl}
            address={address}
            onOpenDetails={() => { window.location.hash = "risk"; }}
            onProtect={() => onProtect()}
          />
        </Panel>
        <Panel title="SDK usage" meta="@riskos/client">
          <pre className="sdk-snippet">{`import { RiskOsClient } from "@riskos/client";

const client = new RiskOsClient({ baseUrl: "${apiBaseUrl}" });
const portfolio = await client.getPortfolio("${address}");
const risk = await client.getRisk("${address}");
// Protective planning stays advisory on mainnet (shadow intents).
`}</pre>
          <p className="form-note">
            Public reads need no account. Alerts and signing still require wallet ownership sessions.
            Mainnet broadcast remains disabled by design.
          </p>
        </Panel>
      </div>
    </>
  );
}
