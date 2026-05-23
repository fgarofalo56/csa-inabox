# Loom Console

The Loom Console is the SaaS-feel front-end that gives federal
customers the Microsoft Fabric workspace experience inside their
Azure tenant. It's a Next.js 14 + Fluent UI v9 application running
in Container Apps (Commercial / GCC) or AKS (GCC-High / IL5).

## Panes (v1)

| # | Pane | Path | Purpose |
|---|---|---|---|
| 1 | Workspaces browser | `/workspaces` | List, filter, create workspaces |
| 2 | Workspace home | `/workspaces/[id]` | Item list across all workspace items |
| 3 | Lakehouse | `/workspaces/[id]/lakehouse/[name]` | Delta tables + files + SQL endpoint + lineage + RLS/CLS |
| 4 | Warehouse | `/workspaces/[id]/warehouse` | SQL editor + schema explorer + query history |
| 5 | Notebook | `/workspaces/[id]/notebook/[id]` | Embedded Databricks notebook iframe with SSO |
| 6 | KQL | `/workspaces/[id]/kql/[db]` | ADX query editor + dashboards iframe |
| 7 | Catalog | `/catalog` | UC + Purview unified browser (or Atlas at IL5) |
| 8 | Activator | `/workspaces/[id]/activator/[id]` | Visual rule designer + execution history |
| 9 | Data Agents | `/workspaces/[id]/agent/[id]` | Per-agent config + test chat |
| 10 | Monitoring Hub | `/monitoring` | Capacity / queries / deploys / audit / cost |
| 11 | Admin | `/admin` | Capacity scale + OAP + tenant settings + Entra groups |
| 12 | Setup Wizard | `/setup` | Conversational deploy (see [Setup Wizard](setup-wizard.md)) |

Plus the Loom Copilot sidebar drawer + full-screen chat at `/copilot`
(see [Copilot runtime](copilot-runtime.md)).

## v1.1 additional panes

- Semantic Model designer (TMDL + DAX editor + Direct-Lake-Shim
  policy editor)
- Marketplace (data products)
- Real-Time Hub (visual stream designer)
- Mirroring (UI for Debezium connector configs; CLI in v1)
- Domains (visual domain hierarchy editor)

## Tech stack

- **Framework**: Next.js 14 (App Router) — server components for
  data fetch + client components for interactivity
- **UI library**: Fluent UI v9 (matches Microsoft Fabric visual
  language; WCAG 2.1 AA baseline)
- **Auth**: MSAL BFF (cookies + refresh server-side; OBO for
  downstream calls)
- **State**: React Query for server state; Zustand for ephemeral UI
- **API**: Next.js Route Handlers under `/api/*` proxy to Azure ARM,
  Databricks REST, Synapse REST, Power BI REST, ADX REST, Purview
  REST, AI Search REST, Loom backend services
- **Embeds**: iframe for Databricks notebook, ADX dashboard, Power BI
  report — SSO via Entra; same-origin via BFF reverse-proxy
- **Test**: Playwright E2E + Vitest unit + axe-core accessibility
- **Container**: multi-stage Dockerfile; ~120 MB image; ACR-hosted
- **Deploy**: Container Apps (Commercial / GCC) or AKS Helm chart
  (GCC-High / IL5)

## Performance targets

| Metric | Target |
|---|---|
| First Contentful Paint | < 1.5 s |
| Largest Contentful Paint | < 2.5 s |
| Time to Interactive | < 3.5 s |
| API response p50 | < 200 ms |
| API response p95 | < 500 ms |
| API response p99 | < 1.5 s |
| Initial bundle (gzipped) | < 400 KB; per-pane lazy-load |

## Accessibility

- WCAG 2.1 AA compliance (Fluent UI v9 baseline)
- Keyboard navigation throughout
- Screen-reader labels
- High-contrast mode (Fluent theming)
- en-US baseline; locale structure ready

## Related

- ADR: [fiab-0007 Console framework](../adr/0007-console-framework.md)
- Build PRP: PRP-03 — `apps/fiab-console/`
- Setup Wizard route: [Setup Wizard](setup-wizard.md)
- Copilot runtime: [Loom Copilot runtime](copilot-runtime.md)
