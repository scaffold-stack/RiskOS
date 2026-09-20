import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../components/Icons.js";

const services: Array<{
  number: string;
  icon: IconName;
  title: string;
  description: string;
  detail: string;
}> = [
  {
    number: "01",
    icon: "overview",
    title: "Portfolio intelligence",
    description:
      "See wallet balances, deployed capital, collateral, debt, liquidity positions, and protocol concentration together.",
    detail: "Normalized positions · valuation boundaries · capital allocation",
  },
  {
    number: "02",
    icon: "shield",
    title: "Deterministic risk",
    description:
      "Understand liquidation distance, LP range, oracle confidence, exit liquidity, bridge state, and unsupported exposure.",
    detail: "Explainable findings · scenarios · confidence",
  },
  {
    number: "03",
    icon: "protect",
    title: "Protective planning",
    description:
      "Preview allowlisted debt-repayment actions with simulation, drift checks, expiry, ownership checks, and post-conditions.",
    detail: "Mainnet advisory · testnet wallet flow · non-custodial",
  },
  {
    number: "04",
    icon: "coins",
    title: "Yield strategies",
    description:
      "Explore evidenced earning markets and compare rates, capacity, confidence, exclusions, and projected gross yield.",
    detail: "Explore mode · recommendation gates · no invented rates",
  },
  {
    number: "05",
    icon: "alerts",
    title: "Risk alerts",
    description:
      "Create wallet-owned policies for material risk categories and review deduplicated evidence-backed occurrences.",
    detail: "Severity policies · occurrence history · wallet ownership",
  },
  {
    number: "06",
    icon: "reports",
    title: "Evidence reports",
    description:
      "Generate current portfolio evidence artifacts with positions, risk findings, provenance, confidence, and integrity boundaries.",
    detail: "Owner authenticated · exportable JSON · current evidence",
  },
  {
    number: "07",
    icon: "integrations",
    title: "Developer platform",
    description:
      "Use the typed SDK, live API explorer, OpenAPI contract, quota controls, API keys, and embeddable React widget.",
    detail: "28 typed methods · API keys · production embeds",
  },
  {
    number: "08",
    icon: "layers",
    title: "Evidence foundation",
    description:
      "Build on canonical events, signed integration registries, reorg-aware snapshots, and independently reconciled sources.",
    detail: "Index-hash bound · signed registry · fail-closed",
  },
];

const journeys = [
  {
    role: "Bitcoin finance user",
    outcome: "Know what you own, what it earns, and what needs attention.",
    steps: [
      "Paste a Stacks address",
      "Review positions and risk",
      "Compare yield evidence",
      "Connect only to save or act",
    ],
  },
  {
    role: "Treasury operator",
    outcome: "Turn fragmented protocol exposure into a repeatable review process.",
    steps: [
      "Inspect capital allocation",
      "Prioritize material findings",
      "Create alert policies",
      "Generate evidence reports",
    ],
  },
  {
    role: "Application developer",
    outcome: "Ship portfolio and risk intelligence without rebuilding protocol adapters.",
    steps: [
      "Test public reads",
      "Create an API key",
      "Integrate the typed SDK",
      "Embed or compose workflows",
    ],
  },
  {
    role: "Protocol team",
    outcome: "Make an integration observable, attributable, and safer to consume.",
    steps: [
      "Review contract registry",
      "Validate normalized positions",
      "Reconcile independent evidence",
      "Monitor integration health",
    ],
  },
] as const;

const evidenceControls = [
  "Liquidation and exit-liquidity scenarios",
  "sBTC Emily, Stacks, and Bitcoin reconciliation",
  "Oracle quorum and source-confidence boundaries",
  "Signed contract registry and provenance controls",
  "Canonical index-block snapshots and reorg invalidation",
] as const;

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || !("IntersectionObserver" in window)) {
      items.forEach((item) => item.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -7% 0px" },
    );
    items.forEach((item) => observer.observe(item));
    const frame = window.requestAnimationFrame(() => root.classList.add("landing-reveal-ready"));
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  function openRoute(route: "integrations" | "pricing" | "protect" | "reports") {
    window.location.hash = route;
  }

  return (
    <div className="app landing-app" ref={rootRef}>
      <nav className="site-nav">
        <button className="logo" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <img src="/logo.svg" alt="RiskOSfolio" />
        </button>
        <div className="site-links">
          <a href="#services">Services</a>
          <a href="#journeys">Who it serves</a>
          <a href="#evidence">Evidence</a>
          <a href="#developers">Developers</a>
        </div>
        <button className="btn primary" onClick={onLaunch}>
          Launch app <Icon name="arrow" size={16} />
        </button>
      </nav>

      <main>
        <section className="hero landing-hero">
          <div className="landing-hero-copy">
            <p className="eyebrow">Bitcoin capital intelligence</p>
            <h1>
              Know the capital.
              <br />
              <em>Understand the risk.</em>
            </h1>
            <p>
              RiskOSfolio is the evidence layer for Bitcoin finance on Stacks: portfolio intelligence,
              deterministic risk, yield research, alerts, reports, developer APIs, and non-custodial
              protective planning.
            </p>
            <div className="hero-actions">
              <button className="btn primary" onClick={onLaunch}>
                Inspect a portfolio <Icon name="arrow" size={16} />
              </button>
              <button className="btn secondary" onClick={() => openRoute("integrations")}>
                Build with RiskOS
              </button>
            </div>
            <div className="hero-proof">
              <div className="proof">
                <strong>28</strong>
                <span>typed SDK methods</span>
              </div>
              <div className="proof">
                <strong>100</strong>
                <span>address release gate</span>
              </div>
              <div className="proof">
                <strong>0</strong>
                <span>custodied funds</span>
              </div>
            </div>
          </div>

          <div className="hero-visual" aria-label="RiskOSfolio evidence terminal preview">
            <div className="preview-window">
              <div className="window-top">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                <b className="mono">LIVE MAINNET READS · ADVISORY PROTECT</b>
              </div>
              <div className="mini-metrics">
                <div className="mini-card">
                  <span>Portfolio</span>
                  <strong>Normalized</strong>
                </div>
                <div className="mini-card">
                  <span>Evidence</span>
                  <strong>Attributed</strong>
                </div>
                <div className="mini-card">
                  <span>Action</span>
                  <strong>User controlled</strong>
                </div>
              </div>
              <div className="hero-chart">
                <svg
                  viewBox="0 0 600 220"
                  width="100%"
                  height="100%"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#12a66f" stopOpacity="0.28" />
                      <stop offset="100%" stopColor="#12a66f" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0 188 C80 170 112 112 178 137 S280 82 345 101 S455 38 600 45 V220 H0 Z"
                    fill="url(#area)"
                  />
                  <path
                    d="M0 188 C80 170 112 112 178 137 S280 82 345 101 S455 38 600 45"
                    fill="none"
                    stroke="#087a50"
                    strokeWidth="2.5"
                  />
                  <path
                    d="M0 202 C120 192 210 175 310 180 S480 138 600 151"
                    fill="none"
                    stroke="#7be0b7"
                    strokeWidth="1.5"
                  />
                </svg>
              </div>
              <div className="landing-terminal-row">
                <span>
                  <i className="healthy" /> Positions discovered
                </span>
                <span>
                  <i className="healthy" /> Risk evaluated
                </span>
                <span>
                  <i className="caution" /> Signing remains user controlled
                </span>
              </div>
            </div>
            <div className="float-card one">
              <div className="float-label">CANONICAL EVIDENCE</div>
              <div className="float-value">Index-hash bound</div>
            </div>
            <div className="float-card two">
              <div className="float-label">PROTECTIVE PLANNING</div>
              <div className="float-value">Simulate before acting</div>
            </div>
          </div>
        </section>

        <div className="landing-band">
          <div className="band-inner">
            {[
              ["Replayable", "canonical event history"],
              ["Fail-closed", "unknown contracts and assets"],
              ["Deterministic", "versioned risk models"],
              ["Non-custodial", "users retain signing control"],
            ].map(([label, detail]) => (
              <div className="band-stat" key={label}>
                <strong>{label}</strong>
                <span>{detail}</span>
              </div>
            ))}
          </div>
        </div>

        <section className="landing-section landing-services" id="services">
          <div className="section-heading" data-reveal>
            <div>
              <p className="eyebrow">One evidence system</p>
              <h2>Every service RiskOSfolio provides.</h2>
            </div>
            <p>
              Each workflow uses the same normalized positions, provenance, confidence, pricing boundaries,
              and canonical chain context. No service invents missing evidence.
            </p>
          </div>
          <div className="landing-services-grid">
            {services.map((service) => (
              <article className="landing-service-card" key={service.number} data-reveal>
                <div className="landing-service-top">
                  <span>{service.number}</span>
                  <i>
                    <Icon name={service.icon} size={19} />
                  </i>
                </div>
                <h3>{service.title}</h3>
                <p>{service.description}</p>
                <code>{service.detail}</code>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-journeys" id="journeys">
          <div className="landing-journeys-inner">
            <div className="section-heading" data-reveal>
              <div>
                <p className="eyebrow">Built around real decisions</p>
                <h2>Different users, one trustworthy evidence boundary.</h2>
              </div>
              <p>
                Start with a public address. Add wallet ownership, reports, alerts, or API capacity only when
                the workflow needs it.
              </p>
            </div>
            <div className="journey-grid">
              {journeys.map((journey, index) => (
                <article className="journey-card" key={journey.role} data-reveal>
                  <div className="journey-role">
                    <span>0{index + 1}</span>
                    <strong>{journey.role}</strong>
                  </div>
                  <p>{journey.outcome}</p>
                  <ol>
                    {journey.steps.map((step, stepIndex) => (
                      <li key={step}>
                        <i>{stepIndex + 1}</i>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="contour-section" id="evidence">
          <div className="contour-inner">
            <div className="contour-copy" data-reveal>
              <p className="eyebrow" style={{ color: "#7be0b7" }}>
                Risk, made legible
              </p>
              <h2>Evidence before confidence. Confidence before action.</h2>
              <p>
                RiskOSfolio does more than aggregate balances. It preserves the observations, contracts,
                source agreement, freshness, and failure modes needed to explain every conclusion.
              </p>
              <div className="contour-list">
                {evidenceControls.map((item) => (
                  <div className="contour-item" key={item}>
                    <Icon name="check" size={15} />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="contour-card" data-reveal>
              <div className="viz-label">Evidence contour</div>
              <div className="micro-bars" aria-hidden="true">
                {[42, 58, 71, 64, 88, 76, 93, 68, 81, 55].map((value, index) => (
                  <i key={index} style={{ height: `${value}%` }} className={value > 85 ? "warn" : ""} />
                ))}
              </div>
              <div className="stat-stack">
                <div className="stat-mini">
                  <b>Deterministic</b>
                  <span>versioned models</span>
                </div>
                <div className="stat-mini">
                  <b>Fail-closed</b>
                  <span>missing evidence</span>
                </div>
                <div className="stat-mini">
                  <b>Advisory</b>
                  <span>mainnet protect</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-section landing-developer-section" id="developers">
          <div className="landing-developer-copy" data-reveal>
            <p className="eyebrow">Developer platform</p>
            <h2>Go from first request to embedded intelligence.</h2>
            <p>
              Build with public reads, wallet-owned sessions, metered API keys, a standalone TypeScript SDK,
              an OpenAPI contract, and a React widget. Free wallets can create one key with 1,000 monthly
              requests.
            </p>
            <div className="landing-dev-capabilities">
              {[
                ["Portfolio", "overview, positions, history"],
                ["Risk", "findings, evidence reports"],
                ["Yield", "markets, strategies, allocations"],
                ["Workflows", "auth, alerts, advisory protect"],
              ].map(([label, detail]) => (
                <div key={label}>
                  <strong>{label}</strong>
                  <span>{detail}</span>
                </div>
              ))}
            </div>
            <div className="hero-actions">
              <button className="btn primary" onClick={() => openRoute("integrations")}>
                Open developer console
              </button>
              <button className="btn secondary" onClick={() => openRoute("pricing")}>
                Compare API plans
              </button>
            </div>
          </div>
          <div className="landing-code-stack" data-reveal>
            <div className="landing-code-tabs">
              <span>TypeScript SDK</span>
              <b>@riskos/client · v0.4</b>
            </div>
            <pre className="code">{`const riskos = new RiskOsClient({
  baseUrl: "https://riskosfolio-api.fly.dev",
  apiKey: process.env.RISKOS_API_KEY
});

const [overview, strategies] = await Promise.all([
  riskos.getOverview(address),
  riskos.getYieldStrategies()
]);`}</pre>
            <div className="landing-endpoint-strip">
              <span>GET</span>
              <code>/v1/yield/strategies</code>
              <b>Evidence-derived</b>
            </div>
          </div>
        </section>

        <section className="landing-workflow-callout" data-reveal>
          <div>
            <p className="eyebrow">From observation to response</p>
            <h2>Inspect publicly. Verify ownership when it matters.</h2>
          </div>
          <div className="landing-workflow-steps">
            {[
              ["01", "Inspect", "Load current positions and evidence."],
              ["02", "Understand", "Review risk, yield, and scenarios."],
              ["03", "Monitor", "Save alerts and generate reports."],
              ["04", "Plan", "Simulate a user-controlled next step."],
            ].map(([number, title, copy]) => (
              <div key={number}>
                <span>{number}</span>
                <strong>{title}</strong>
                <p>{copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="cta">
          <div>
            <h2>Know what your Bitcoin capital is doing.</h2>
            <p>Inspect a mainnet address, trace the evidence, and decide the safer next step.</p>
          </div>
          <button className="btn" onClick={onLaunch}>
            Launch RiskOSfolio <Icon name="arrow" size={16} />
          </button>
        </section>
      </main>

      <footer>
        <div className="footer-inner">
          <div className="logo inverse">
            <img src="/logo-inverse.svg" alt="RiskOSfolio" />
          </div>
          <div className="footer-links">
            <span>Evidence-backed</span>
            <span>Non-custodial by design</span>
            <span>© 2026 RiskOSfolio</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
