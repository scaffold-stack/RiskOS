import type { ReactNode } from "react";

export function MeaningCallout({
  question,
  answer,
  tone = "neutral",
}: {
  question: string;
  answer: string;
  tone?: "neutral" | "good" | "caution" | "critical";
}) {
  return (
    <aside className={`meaning-callout ${tone}`}>
      <span>{question}</span>
      <p>{answer}</p>
    </aside>
  );
}

export function ExplainedMetric({
  label,
  value,
  meaning,
  tone = "neutral",
}: {
  label: string;
  value: string;
  meaning: string;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <article className="explained-metric">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      <p>{meaning}</p>
    </article>
  );
}

export function DonutChart({
  segments,
  center,
  caption,
}: {
  segments: Array<{ key: string; bps: number; color: string }>;
  center: string;
  caption: string;
}) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="chart-block">
      <svg viewBox="0 0 120 120" className="donut-chart" role="img" aria-label={caption}>
        <circle cx="60" cy="60" r={radius} fill="none" stroke="var(--border)" strokeWidth="14" />
        {segments.filter((segment) => segment.bps > 0).map((segment) => {
          const length = (segment.bps / 10_000) * circumference;
          const node = (
            <circle
              key={segment.key}
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth="14"
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            >
              <title>{`${segment.key}: ${(segment.bps / 100).toFixed(1)}%`}</title>
            </circle>
          );
          offset += length;
          return node;
        })}
        <text x="60" y="58" textAnchor="middle" className="donut-center-value">{center}</text>
        <text x="60" y="72" textAnchor="middle" className="donut-center-label">assets</text>
      </svg>
      <ul className="chart-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <i style={{ background: segment.color }} />
            <span>{segment.key}</span>
            <b>{(segment.bps / 100).toFixed(1)}%</b>
          </li>
        ))}
      </ul>
      <small className="chart-caption">{caption}</small>
    </div>
  );
}

export function BarChart({
  bars,
  caption,
}: {
  bars: Array<{ key: string; bps: number; valueLabel: string }>;
  caption: string;
}) {
  const max = Math.max(...bars.map((bar) => bar.bps), 1);
  return (
    <div className="chart-block">
      <div className="bar-chart" role="img" aria-label={caption}>
        {bars.map((bar) => (
          <div key={bar.key} className="bar-row">
            <span>{bar.key}</span>
            <i>
              <b style={{ width: `${Math.max(4, (bar.bps / max) * 100)}%` }} title={`${bar.key}: ${bar.valueLabel}`} />
            </i>
            <em>{bar.valueLabel}</em>
          </div>
        ))}
      </div>
      <small className="chart-caption">{caption}</small>
    </div>
  );
}

export function StackedSplit({
  deployedBps,
  idleBps,
  lockedBps,
  caption,
}: {
  deployedBps: number;
  idleBps: number;
  lockedBps: number;
  caption: string;
}) {
  return (
    <div className="chart-block">
      <div className="stacked-split" role="img" aria-label={caption}>
        <span style={{ width: `${deployedBps / 100}%` }} className="deployed" title={`Deployed ${(deployedBps / 100).toFixed(1)}%`} />
        <span style={{ width: `${idleBps / 100}%` }} className="idle" title={`Idle ${(idleBps / 100).toFixed(1)}%`} />
        <span style={{ width: `${lockedBps / 100}%` }} className="locked" title={`Locked ${(lockedBps / 100).toFixed(1)}%`} />
      </div>
      <ul className="chart-legend compact">
        <li><i className="deployed" /><span>Deployed</span><b>{(deployedBps / 100).toFixed(1)}%</b></li>
        <li><i className="idle" /><span>Idle</span><b>{(idleBps / 100).toFixed(1)}%</b></li>
        <li><i className="locked" /><span>Locked</span><b>{(lockedBps / 100).toFixed(1)}%</b></li>
      </ul>
      <small className="chart-caption">{caption}</small>
    </div>
  );
}

export function RangeChart({
  lower,
  upper,
  current,
  caption,
}: {
  lower: number;
  upper: number;
  current: number;
  caption: string;
}) {
  const span = Math.max(upper - lower, 1);
  const pad = span * 0.15;
  const min = lower - pad;
  const max = upper + pad;
  const width = max - min;
  const left = ((lower - min) / width) * 100;
  const rangeWidth = ((upper - lower) / width) * 100;
  const marker = ((current - min) / width) * 100;
  return (
    <div className="chart-block">
      <div className="range-chart" role="img" aria-label={caption}>
        <div className="range-track">
          <span className="range-active" style={{ left: `${left}%`, width: `${rangeWidth}%` }} />
          <span className="range-marker" style={{ left: `${marker}%` }} title={`Market ${current}`} />
        </div>
        <div className="range-labels">
          <span>{lower.toLocaleString()}</span>
          <strong>{current.toLocaleString()}</strong>
          <span>{upper.toLocaleString()}</span>
        </div>
      </div>
      <small className="chart-caption">{caption}</small>
    </div>
  );
}

export function LiquidationDistance({
  current,
  liquidation,
  caption,
}: {
  current: number;
  liquidation: number;
  caption: string;
}) {
  const min = Math.min(current, liquidation) * 0.9;
  const max = Math.max(current, liquidation) * 1.05;
  const width = max - min || 1;
  const currentPct = ((current - min) / width) * 100;
  const liqPct = ((liquidation - min) / width) * 100;
  return (
    <div className="chart-block">
      <div className="liq-distance" role="img" aria-label={caption}>
        <div className="liq-track">
          <span className="liq-safe" style={{ width: `${Math.min(currentPct, liqPct)}%` }} />
          <i className="liq-mark current" style={{ left: `${currentPct}%` }} title={`Current $${current.toLocaleString()}`} />
          <i className="liq-mark danger" style={{ left: `${liqPct}%` }} title={`Liquidation $${liquidation.toLocaleString()}`} />
        </div>
        <div className="range-labels">
          <span>Now ${current.toLocaleString()}</span>
          <span>Liq ${liquidation.toLocaleString()}</span>
        </div>
      </div>
      <small className="chart-caption">{caption}</small>
    </div>
  );
}

export function BeforeAfter({
  before,
  after,
}: {
  before: Array<{ label: string; value: string }>;
  after: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="before-after">
      <div>
        <h4>Before</h4>
        {before.map((row) => (
          <div key={row.label}><span>{row.label}</span><strong>{row.value}</strong></div>
        ))}
      </div>
      <div>
        <h4>After (simulated)</h4>
        {after.map((row) => (
          <div key={row.label}><span>{row.label}</span><strong>{row.value}</strong></div>
        ))}
      </div>
    </div>
  );
}

export function FreshnessStrip({
  children,
}: {
  children: ReactNode;
}) {
  return <div className="freshness-strip">{children}</div>;
}

const PALETTE = ["#087a50", "#12a66f", "#2fc891", "#62dbae", "#0a8f5f", "#bd721c", "#4169b2"];

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}
