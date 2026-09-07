---
name: riskosfolio-ui
description: >-
  RiskOSfolio Green Terminal brand UI. Use when building or restyling apps/web,
  landing, overview, positions, risk, protect, or any RiskOSfolio interface.
  Enforces white+forest/emerald tokens, DM Sans + IBM Plex Mono, and live mainnet
  data wiring — never fake portfolio numbers in the live shell.
---

# RiskOSfolio Green Terminal UI

## Source of truth

- Prototype: `new UI/` (styles.css, app.js, design-tokens.json, assets/)
- Live app: `apps/web/`
- Tokens: `apps/web/design-tokens.json`

## Brand

- Direction: Bitcoin Treasury Terminal — white + forest/emerald
- Interface font: **DM Sans**
- Data font: **IBM Plex Mono**
- Primary CTA: emerald `#12A66F` / deep `#087A50`
- Ink sidebar: `#061D15` → `#0A3426`
- Canvas: `#F5FAF7`, paper `#FFFFFF`, border `#DCEAE3`
- Status: sage healthy, amber caution, red critical, blue uncertain

## Layout

- Landing: sticky site-nav, hero, modules, contour, integrations, API, CTA
- App shell: fixed dark sidebar + main + mobile bottom bar
- Primary nav: overview, positions, risk, protect, alerts
- Secondary: markets, bridge, rewards, reports, team, integrations, settings

## Motion & taste (Emil Kowalski / impeccable)

- Transitions 150–220ms ease; hover lifts `translateY(-1px)` on buttons only
- Prefer CSS/SVG charts (mono terminal aesthetic) over heavy chart libraries
- No emoji icons — SVG strokes only
- Respect `prefers-reduced-motion`
- One job per section; avoid purple-on-white / cream-terracotta AI defaults

## ShadCN / Remotion / Mono charts guidance

- Prefer semantic tokens + panel/metric primitives matching the CSS system over installing a full shadcn stack unless explicitly requested
- Charts: area/line/contour/depth SVG, micro-bars, heatmaps, donuts — IBM Plex Mono labels
- Remotion: only for marketed motion pieces; product UI stays CSS/SVG

## Data honesty

- Live mode must call `/v1/address/...` APIs; never invent `$428k` in production UI
- Protect remains advisory on mainnet (shadow intents)
- Empty / loading / degraded states are first-class
- Default inspect address for demos: a known mainnet whale, not the zero address when `DATA_MODE=live`

## Checklist before shipping UI

- [ ] Tokens match design-tokens.json
- [ ] Brand logo uses `/logo.svg` or `/logo-inverse.svg`
- [ ] Clickable elements have cursor + hover
- [ ] Mobile bottom nav works ≤700px
- [ ] Live inspect path wired
