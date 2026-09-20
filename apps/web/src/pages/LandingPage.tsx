import { Icon } from "../components/Icons.js";

const modules = [
  ["01", "Unified position API", "Balances, debt, collateral, and LP ranges normalized behind one address."],
  ["02", "Stacks-native risk engine", "Liquidation, exit-liquidity, bridge, oracle, and unsupported-exposure findings."],
  ["03", "Protective planning", "Allowlisted, expiring actions are simulated. Mainnet remains advisory until execution gates pass."],
  ["04", "Evidence foundation", "Canonical events, signed registries, source confidence, and reorg-aware snapshots."],
] as const;

export function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="app">
      <nav className="site-nav">
        <button className="logo" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <img src="/logo.svg" alt="" />
          <span>
            RiskOS<sup>folio</sup>
          </span>
        </button>
        <div className="site-links">
          <a href="#product">Product</a>
          <a href="#risk-engine">Risk engine</a>
          <a href="#developers">Developers</a>
        </div>
        <button className="btn primary" onClick={onLaunch}>
          Launch app <Icon name="arrow" size={16} />
        </button>
      </nav>

      <section className="hero" style={{ paddingLeft: 24, paddingRight: 24 }}>
        <div>
          <p className="eyebrow">Bitcoin treasury terminal</p>
          <h1>
            See the risk.
            <br />
            <em>Protect the Bitcoin.</em>
          </h1>
          <p>
            RiskOSfolio answers one question: where is your Bitcoin capital, what is it earning, what can go wrong,
            and what is the safest user-controlled next step right now — without custody.
          </p>
          <div className="hero-actions">
            <button className="btn primary" onClick={onLaunch}>
              Open risk console <Icon name="arrow" size={16} />
            </button>
            <a className="btn secondary" href="#product">
              Explore the system
            </a>
          </div>
          <div className="hero-proof">
            <div className="proof">
              <strong>3-source</strong>
              <span>sBTC reconciliation</span>
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
        <div className="hero-visual">
          <div className="preview-window">
            <div className="window-top">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <b className="mono">READ-ONLY · EVIDENCE MODE</b>
            </div>
            <div className="mini-metrics">
              <div className="mini-card">
                <span>Risk posture</span>
                <strong>Guarded</strong>
              </div>
              <div className="mini-card">
                <span>Confidence</span>
                <strong>Verified</strong>
              </div>
              <div className="mini-card">
                <span>Mainnet action</span>
                <strong>Advisory</strong>
              </div>
            </div>
            <div className="hero-chart">
              <svg viewBox="0 0 600 220" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#12a66f" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#12a66f" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 188 C80 170 112 112 178 137 S280 82 345 101 S455 38 600 45 V220 H0 Z" fill="url(#area)" />
                <path d="M0 188 C80 170 112 112 178 137 S280 82 345 101 S455 38 600 45" fill="none" stroke="#087a50" strokeWidth="2.5" />
                <path d="M0 202 C120 192 210 175 310 180 S480 138 600 151" fill="none" stroke="#7be0b7" strokeWidth="1.5" />
              </svg>
            </div>
          </div>
          <div className="float-card one">
            <div className="float-label">CANONICAL DATA</div>
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

      <section className="landing-section" id="product" style={{ paddingLeft: 24, paddingRight: 24 }}>
        <div className="section-heading">
          <h2>From fragmented positions to protective action.</h2>
          <p>Four product modules share a normalized, provenance-aware data model so every decision can be traced.</p>
        </div>
        <div className="module-grid">
          {modules.map(([number, title, description]) => (
            <article className="module" key={number}>
              <div className="module-no">MODULE {number}</div>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="contour-section" id="risk-engine">
        <div className="contour-inner">
          <div className="contour-copy">
            <p className="eyebrow" style={{ color: "#7be0b7" }}>
              Risk, made legible
            </p>
            <h2>A risk model built for Bitcoin on Stacks.</h2>
            <p>Beyond balances — preserve the evidence and failure modes that determine whether capital is truly safe.</p>
            <div className="contour-list">
              {["Liquidation and exit-liquidity scenarios", "sBTC Emily / Stacks / Bitcoin reconciliation", "Oracle and source confidence", "Contract-registry and provenance controls"].map(
                (item) => (
                  <div className="contour-item" key={item}>
                    <i>✓</i>
                    <span>{item}</span>
                  </div>
                ),
              )}
            </div>
          </div>
          <div className="contour-card">
            <div className="viz-label">Evidence contour</div>
            <div className="micro-bars" aria-hidden="true">
              {[42, 58, 71, 64, 88, 76, 93, 68, 81, 55].map((v, i) => (
                <i key={i} data-v={v} style={{ height: `${v}%` }} className={v > 85 ? "warn" : ""} />
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

      <section className="landing-section" id="developers" style={{ paddingLeft: 24, paddingRight: 24 }}>
        <div className="api-panel">
          <div className="api-copy">
            <p className="eyebrow">Built for builders</p>
            <h2>One schema for Bitcoin positions and risk.</h2>
            <p>Consume normalized positions, findings, provenance, confidence, and unsigned simulations through a versioned API.</p>
            <button className="btn primary" onClick={onLaunch}>
              Explore the live interface
            </button>
          </div>
          <pre className="code">
            <span className="o">GET</span> /v1/address/SP…/risk{"\n\n"}
            {"{\n  "}
            <span className="g">"risks"</span>
            {": [{\n    "}
            <span className="g">"category"</span>
            {": "}
            <span className="o">"liquidation"</span>
            {",\n    "}
            <span className="g">"score"</span>
            {": 82,\n    "}
            <span className="g">"confidence"</span>
            {": { "}
            <span className="g">"state"</span>
            {": "}
            <span className="o">"verified"</span>
            {" }\n  }]\n}"}
          </pre>
        </div>
      </section>

      <section className="cta">
        <div>
          <h2>Know what your Bitcoin is exposed to.</h2>
          <p>Inspect a mainnet address. See the evidence. Prepare the safer move.</p>
        </div>
        <button className="btn" onClick={onLaunch}>
          Launch RiskOSfolio <Icon name="arrow" size={16} />
        </button>
      </section>

      <footer>
        <div className="footer-inner" style={{ paddingLeft: 24, paddingRight: 24 }}>
          <div className="logo inverse">
            <img src="/logo-inverse.svg" alt="" />
            <span>
              RiskOS<sup>folio</sup>
            </span>
          </div>
          <div className="footer-links">
            <span>Non-custodial by design</span>
            <span>© 2026 RiskOSfolio</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
