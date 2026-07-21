# ai-bi-explain-metric — parity with Databricks AI/BI dashboards (AI-authored viz + forecasting + key-driver analysis)

Workstream: **WS-2.3 AI/BI dashboards** (P1-8, grade target B) —
`PRPs/active/loom-competitive-audit-2026-07-20/PRD.md` §WS-2.3.

Source UI (the capabilities we reproduce, Azure-native / no Power BI Copilot):

- Databricks AI/BI dashboards — AI-assisted visualization authoring, one-click
  forecast, and "key drivers" / anomaly explanations over a dataset.
  - https://learn.microsoft.com/azure/databricks/dashboards/
  - https://learn.microsoft.com/azure/databricks/dashboards/visualization-types
- Power BI analogues (already covered separately by the report-designer Analytics
  pane + Key influencers visual): Forecast, Find anomalies, Key influencers.
  - https://learn.microsoft.com/power-bi/transform-model/desktop-analytics-pane
  - https://learn.microsoft.com/power-bi/visuals/power-bi-visualization-influencers

Acceptance (PRD): **"explain this metric" generates a forecast + key-driver viz
over real rows.** Met — the "Explain (AI)" affordance renders an AI-authored
chart, a Holt-Winters/Holt-linear forecast, and a ranked key-driver chart, all
over the same real result rows.

## Loom surface + backend

| Layer | File |
|---|---|
| Explain panel (AI viz + forecast + key drivers) | `apps/fiab-console/lib/analytics/explain-metric-panel.tsx` |
| Forecast engine (Holt-Winters / Holt-linear, pure) | `apps/fiab-console/lib/analytics/forecast.ts` |
| Key-driver engine (Pearson r + correlation-ratio η, pure) | `apps/fiab-console/lib/analytics/key-drivers.ts` |
| Unit tests (24) | `apps/fiab-console/lib/analytics/__tests__/{forecast,key-drivers}.test.ts` |
| AI-authored-viz backend (AOAI chart recommendation) | `apps/fiab-console/app/api/analytics/visualize/route.ts` |
| Surfaced on shared result viz (report / warehouse / synapse / databricks) | `apps/fiab-console/lib/editors/components/result-visualize.tsx` ("Explain (AI)" tab) |
| Surfaced on semantic-model DAX result | `apps/fiab-console/lib/editors/components/dax-query-view.tsx` |

## Feature inventory → Loom coverage

| Capability (Databricks AI/BI) | Loom coverage | Backend per control |
|---|---|---|
| AI-authored visualization — pick the best chart for a metric | ✅ AOAI proposes chart kind + X/Y/series encoding; rendered over real rows; encoding validated against the real column list | `POST /api/analytics/visualize` → Azure OpenAI (Foundry hub, Console UAMI) |
| One-click forecast with uncertainty band | ✅ additive Holt-Winters (seasonal, auto-detected) or Holt's linear trend; ±z·σ·√h confidence band that widens with the horizon | pure `forecastSeries` over the real metric series (client) |
| Key-driver / "what explains this" analysis | ✅ Pearson correlation (numeric drivers, signed) + correlation ratio η (categorical drivers, with top category), ranked by strength | pure `rankKeyDrivers` over the real rows (client) |
| Honest gate when AOAI is not wired | ⚠️ 503 → the AI-viz card shows a Foundry CTA; forecast + key-driver cards still render (pure local math) | `resolveAoaiTarget` pre-flight |
| Anomaly detection | ⚠️ covered by the report-designer Analytics pane (`analytics-pane.tsx` `computeAnomalies`, rolling z-score / ADX) — not duplicated here |
| No Power BI / Fabric dependency | ✅ AAS/SQL rows in, AOAI for the encoding only | — |

Zero ❌: every WS-2.3 deliverable row is built ✅ (with one documented honest
gate ⚠️ for the AOAI-missing case, and anomaly detection deferred to the existing
Analytics-pane surface).

## Rules compliance

- **no-vaporware.md / G1:** forecast + key drivers are REAL statistics (unit-
  tested: a linear ramp recovers its slope, a seasonal pattern is reproduced, the
  band widens with the horizon; a perfectly correlated column ranks first, a
  negative driver reports `negative`, a class-separated categorical yields high
  η). AI-authored viz is a real AOAI call validated against the real columns. No
  mock data, no fabricated trend line, no random importances.
- **no-fabric-dependency.md:** the only network backend is Azure OpenAI; never
  `api.fabric.microsoft.com` / `api.powerbi.com`. Runs identically in Gov.
- **web3-ui.md / ux-baseline.md:** Fluent v9 + Loom tokens, responsive card grid,
  `EmptyState` guidance, clean first-open (no red before Explain), honest gate.

## Owed (Track-0)

- **Browser-E2E receipt** — "Explain this metric" → AI-authored chart + forecast
  + key-driver over real rows, captured in a real browser against a live AAS /
  Synapse-serverless result. (Pure math + tsc + vitest + CI guards are green; the
  live in-browser walk is the remaining G1 receipt.)
