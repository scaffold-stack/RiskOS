import { useEffect, useState } from "react";
import { getPlans, type CommercialPlanView } from "../api.js";
import { EmptyState, LoadingState, PageHeader, StatusChip } from "../components/Ui.js";

export function PricingPage({
  walletConnected,
  onConnect,
  onNavigate,
}: {
  walletConnected: boolean;
  onConnect: () => void;
  onNavigate: (route: "overview" | "integrations") => void;
}) {
  const [plans, setPlans] = useState<CommercialPlanView[] | null>(null);
  const [error, setError] = useState("");
  const salesUrl = String(import.meta.env.VITE_SALES_URL ?? "").trim();

  useEffect(() => {
    let cancelled = false;
    void getPlans()
      .then((response) => {
        if (!cancelled) setPlans(response.plans);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load plans");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function selectPlan(plan: CommercialPlanView) {
    if (plan.id === "free") return onNavigate("overview");
    if (plan.id === "developer") return onNavigate("integrations");
    if ((plan.id === "pro" || plan.id === "treasury") && !walletConnected) return onConnect();
    if (!salesUrl) return;
    const target = new URL(salesUrl, window.location.origin);
    target.searchParams.set("plan", plan.id);
    window.open(target.toString(), "_blank", "noopener,noreferrer");
  }

  return (
    <>
      <PageHeader
        title="Plans built around durable outcomes"
        description="Current inspection stays free. Paid plans add persistence, deeper evidence, operational controls, and supported integrations—not access to invented data."
      />
      {error ? (
        <EmptyState
          title="Plans are temporarily unavailable"
          description={error}
          action={<button className="btn secondary" onClick={() => window.location.reload()}>Retry</button>}
        />
      ) : !plans ? (
        <LoadingState />
      ) : (
        <>
          <section className="pricing-grid" aria-label="RiskOSfolio plans">
            {plans.map((plan) => {
              const featured = plan.id === "pro" || plan.id === "developer";
              const contactRequired = plan.priceUsdMonthly === null;
              const needsSales = !["free", "developer"].includes(plan.id);
              const disabled = needsSales && walletConnected && !salesUrl;
              return (
                <article className={`pricing-card ${featured ? "featured" : ""}`} key={plan.id}>
                  <div className="pricing-card-top">
                    <div>
                      <span className="pricing-audience">{plan.audience}</span>
                      <h2>{plan.name}</h2>
                    </div>
                    {featured ? <StatusChip tone="healthy">Recommended</StatusChip> : null}
                  </div>
                  <div className="pricing-price">
                    {contactRequired ? (
                      <strong>Custom</strong>
                    ) : (
                      <>
                        <strong>${plan.priceUsdMonthly}</strong>
                        {plan.priceUsdMonthly ? <span>/ month</span> : null}
                      </>
                    )}
                  </div>
                  <ul className="pricing-features">
                    {plan.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
                  </ul>
                  <button
                    className={`btn ${featured ? "primary" : "secondary"} full`}
                    type="button"
                    disabled={disabled}
                    onClick={() => selectPlan(plan)}
                  >
                    {plan.id === "free"
                      ? "Continue free"
                      : plan.id === "developer"
                        ? "View SDK"
                        : !walletConnected && (plan.id === "pro" || plan.id === "treasury")
                          ? "Connect wallet"
                          : disabled
                            ? "Paid pilot provisioning"
                            : "Request paid access"}
                  </button>
                  {disabled ? (
                    <small className="pricing-note">Set VITE_SALES_URL to activate paid-plan requests.</small>
                  ) : null}
                </article>
              );
            })}
          </section>
          <section className="commercial-trust">
            <div>
              <strong>No execution fee today</strong>
              <p>Mainnet Protect remains advisory and shadow-only. RiskOSfolio does not charge for transactions it cannot execute.</p>
            </div>
            <div>
              <strong>Evidence does not become sponsored ranking</strong>
              <p>Protocol partnerships fund integrations and monitoring. They do not buy a better risk or yield position.</p>
            </div>
            <div>
              <strong>Manual provisioning during launch</strong>
              <p>Paid pilots are reviewed before activation while delivery, support, and API capacity are validated.</p>
            </div>
          </section>
        </>
      )}
    </>
  );
}
