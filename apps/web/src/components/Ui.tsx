import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="toolbar">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  meta,
  children,
  className = "",
}: {
  title: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <div className="panel-title">{title}</div>
        {meta ? <div className="panel-meta">{meta}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <article className="metric">
      <div className="metric-label">
        <span>{label}</span>
      </div>
      <div className={`metric-value ${tone === "good" ? "good" : tone === "bad" ? "bad" : ""}`}>{value}</div>
      <div className={`metric-change ${tone === "bad" ? "down" : ""}`}>{detail}</div>
    </article>
  );
}

export type StatusTone = "healthy" | "caution" | "critical" | "uncertain";

export function StatusChip({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
      <div className="empty-content">
        <div className="empty-icon">R</div>
        <h2>{title}</h2>
        <p>{description}</p>
        {action ? <div className="empty-action">{action}</div> : null}
      </div>
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="loading-state" role="status">
      <span />
      <span />
      <span />
      <p>Resolving canonical positions and risk evidence…</p>
    </div>
  );
}
