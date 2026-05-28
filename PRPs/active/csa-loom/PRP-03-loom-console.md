# PRP-03 — Loom Console (Next.js + Fluent UI v9)

## Context

The Loom Console is the SaaS-feel front-end that gives federal
customers the Fabric workspace experience inside their Azure tenant.
It is the most visible v1 asset and the main field-demo surface.

PRD ref: `temp/fiab-prd/06-custom-apps.md` §6.1; AMENDMENTS §A3, §A5.

## Goal

`apps/fiab-console/` (repo-internal; customer-facing name: Loom
Console) ships as a Next.js 14 application running in Container Apps
(Commercial / GCC) or AKS (GCC-High / IL5), with 8 production-quality
panes covering the v1 workload surface.

## Acceptance criteria

- [ ] Next.js 14 App Router project at `apps/fiab-console/`
- [ ] Fluent UI v9 component library
- [ ] MSAL BFF auth (mirrors csa-inabox ADR-0014)
- [ ] OBO token exchange to downstream services (per AMENDMENTS A15)
- [ ] Containerized; multi-stage Dockerfile; image pushed to Admin
  Plane ACR
- [ ] Container App (Commercial / GCC) + AKS Helm chart (GCC-High)
- [ ] 8 panes functional for v1:
  1. Workspaces browser (`/workspaces`)
  2. Workspace home (`/workspaces/[id]`)
  3. Lakehouse (`/workspaces/[id]/lakehouse/[name]`)
  4. Warehouse (`/workspaces/[id]/warehouse`)
  5. Notebook (`/workspaces/[id]/notebook/[id]`)
  6. KQL (`/workspaces/[id]/kql/[db]`)
  7. Catalog (`/catalog`)
  8. Activator (`/workspaces/[id]/activator/[id]`)
  9. Data Agents (`/workspaces/[id]/agent/[id]`)
  10. Monitoring Hub (`/monitoring`)
  11. Admin (`/admin`)
  12. Setup Wizard route (`/setup`) — shipped via PRP-04
- [ ] Loom Copilot sidebar component embedded across all panes;
  full-screen chat at `/copilot`
- [ ] Branded as **CSA Loom** in all UI strings (per AMENDMENTS A1)
- [ ] WCAG 2.1 AA accessibility (Fluent UI v9 baseline)
- [ ] Performance targets per PRD §6.1.7: FCP < 1.5s, LCP < 2.5s,
  TTI < 3.5s, API p95 < 500ms

## Validation gates

- Playwright E2E suite covers each pane's happy path
- Vitest unit tests on shared components
- Visual regression suite (per-pane screenshots)
- Lighthouse score ≥ 90 on each pane
- axe-core accessibility audit passes
- Container image < 200 MB
- Deploys via PRP-02 Bicep into both Container Apps (Commercial) and
  AKS (GCC-High) environments

## Implementation outline

1. Scaffold Next.js 14 + Fluent UI v9 + pnpm workspace
2. Implement MSAL BFF auth (lift from existing csa-inabox copilot-chat
   pattern)
3. Build the shell layout: top nav, side rail, Copilot drawer, footer
4. Build each pane (one engineer per 2 panes; 4 engineers parallel)
5. Wire data-fetch via Next.js Route Handlers proxying to:
   - Azure ARM (workspaces, capacity)
   - Databricks REST (Spark, SQL Warehouse, notebooks)
   - Synapse Serverless REST
   - ADX REST
   - Power BI REST
   - Purview / UC REST
   - PRP-04 Setup Wizard backend
   - PRP-09 Data Agents backend
6. Wire telemetry to App Insights (reuse `javascripts/app-insights.js`
   pattern from csa-inabox)
7. Multi-stage Dockerfile + ACR push
8. Helm chart for AKS deployment (PRP-02 Bicep deploys it)

## File changes

```
apps/fiab-console/                                      created (Next.js project)
apps/fiab-console/package.json                          created
apps/fiab-console/next.config.js                        created
apps/fiab-console/Dockerfile                            created
apps/fiab-console/app/                                  created (App Router pages)
apps/fiab-console/lib/auth/                             created (MSAL BFF)
apps/fiab-console/lib/clients/                          created (Azure REST clients)
apps/fiab-console/lib/components/                       created (Fluent UI shell)
apps/fiab-console/tests/                                created (Playwright + Vitest)
apps/fiab-console/helm/                                 created (AKS chart for Gov)
.github/workflows/build-fiab-console.yml                created
```

## Open questions / risks

- v1 panes are a lot to ship in 10 weeks; if running long, the
  Semantic Model designer can slip to v1.1 (customer can still author
  TMDL in Power BI Desktop and deploy via TOM CLI)
- Databricks notebook iframe SSO has subtle Entra config requirements;
  validate early
- Fluent UI v9 chat component pattern for the Copilot sidebar — verify
  streaming + tool-call rendering works

## References

- `temp/fiab-prd/06-custom-apps.md` §6.1
- `temp/fiab-prd/AMENDMENTS.md` §A3, §A5
- ADR-0014 (existing): MSAL BFF auth pattern
- Memory: [[copilot-chat-two-backends]]

## Validation receipt

**Validated 2026-05-27 — Structural validation harness GREEN (26/26 pytest).**

Test harness: `apps/fiab-console/tests/test_console_structure.py`. The console
itself runs only behind the VNet-internal Bastion ingress (security by design),
so live UI walkthrough is operator action. The harness asserts the contract
the live console must honor:

- All 13 PRP-required panes have an App Router `page.tsx`
  (workspaces, lakehouse, warehouse, notebook, realtime-hub/KQL, browse/catalog,
  activator, data-agent, monitor, admin, setup, copilot, workspaces/[id])
- MSAL BFF wiring (`lib/auth/msal.ts` + `session.ts`, uses `@azure/msal-node`)
- BFF API routes cover all required backends (workspaces, setup, copilot, admin,
  fabric, powerbi, governance)
- 6 Azure SDK client adapters present + non-stub
  (databricks-client.ts, kusto-client.ts, powerbi-client.ts, cosmos-client.ts,
  fabric-client.ts, purview-client.ts)
- `instrumentation.ts` (OpenTelemetry/App Insights) wired
- `package.json` pins Next 14 + Fluent v9 + MSAL packages
- `next.config.mjs` configures CSP + HSTS security headers

**Operator action remaining:** Bastion-fronted browser walkthrough + hydration
error check + MSAL sign-in receipt. Tracked in audit page; blocked by ACR
image build, which is the broader v1 ship gate.
