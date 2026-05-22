# fiab-0007: Console framework — Next.js 14 + Fluent UI v9 + MSAL BFF

**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-5

## Context

The Loom Console is the SaaS-feel front-end that gives federal
customers the Fabric workspace experience inside their Azure tenant.
It is the most visible v1 asset and the primary field-demo surface.

Framework choices considered:
- **Next.js 14 (App Router) + Fluent UI v9 + MSAL BFF** — matches
  Fabric's React + Fluent UI stack exactly
- **Blazor Server + Fluent UI Blazor** — Microsoft-first; C#
  end-to-end; smaller team
- **Power Apps Canvas** — lowest-code; visual designer
- **Custom HTML + minimal framework** — maximal control; massive
  engineering effort

Key requirements:
1. Visually match Microsoft Fabric workspace (customers should feel
   immediately at home)
2. Embed Databricks notebook iframe with SSO
3. Embed ADX dashboard iframe
4. Embed Power BI report iframe
5. Stream chat (SSE) for Loom Copilot + Setup Wizard
6. Be deployable in Container Apps (Commercial / GCC) and AKS
   (GCC-High / IL5) — no host-specific quirks
7. WCAG 2.1 AA accessibility
8. Per-pane lazy-loading for bundle-size discipline
9. Existing csa-inabox uses MSAL BFF pattern (ADR-0014) — reuse

## Decision

**Next.js 14 (App Router) + Fluent UI v9 + MSAL BFF.**

Stack details:

- **Framework**: Next.js 14, App Router, server components for data
  fetch + client components for interactivity
- **UI library**: Fluent UI v9 — the same library Microsoft Fabric
  uses in commercial Azure. Gives us native dark/light themes, WCAG
  baseline, the Microsoft visual language
- **Auth**: MSAL BFF (Backend-For-Frontend) with cookies + refresh
  handled server-side. Mirrors the existing csa-inabox ADR-0014
  pattern. OBO token exchange for downstream Azure REST calls per
  ADR-fiab-0014 (OBO Copilot identity throughout)
- **State**: React Query for server state; Zustand for ephemeral UI
- **API**: Next.js Route Handlers under `/api/*` proxy to Azure ARM,
  Databricks REST, Synapse REST, Power BI REST, ADX REST, Purview
  REST, AI Search REST, Loom backend services
- **Embeds**: iframe embeds for Databricks notebook, ADX dashboard,
  Power BI report — SSO via Entra; same-origin policy handled via BFF
  reverse-proxy
- **Build**: pnpm workspace; multi-stage Dockerfile; ~120 MB image
- **Test**: Playwright E2E; Vitest unit
- **Deployment**: Container image; Container Apps (Commercial / GCC)
  or AKS (GCC-High / IL5)
- **i18n**: English baseline; structure ready for future locales

v1 pane scope (12 panes):

1. Workspaces browser
2. Workspace home
3. Lakehouse (tables + files + SQL endpoint + lineage + RLS/CLS)
4. Warehouse (SQL editor + schema explorer + query history)
5. Notebook (Databricks iframe)
6. KQL (ADX query editor + dashboards iframe)
7. Catalog (UC + Purview unified browser)
8. Activator (rule designer + execution history)
9. Data Agents (per-agent config + test chat)
10. Monitoring Hub (capacity / queries / deploys / audit / cost)
11. Admin (capacity scale + OAP + tenant settings + Entra groups)
12. Setup Wizard route (conversational deploy)

v1.1 panes:
- Semantic Model designer (TMDL + DAX editor + Direct-Lake-Shim
  policy editor)
- Marketplace (data products)
- Real-Time Hub (visual stream designer)
- Mirroring (UI for Debezium connector configs)

## Consequences

### Positive

- Direct visual parity with Microsoft Fabric — Fluent UI v9 is the
  same library; familiar to anyone who's seen Fabric Commercial
- Next.js + React ecosystem is the largest frontend talent pool
- MSAL BFF pattern is production-grade in the existing csa-inabox
  copilot-chat — lifts directly
- Server-side rendering keeps initial bundle small + first-paint fast
- Per-pane lazy-loading via App Router file-based code-splitting
- SSE for chat works natively in Next.js Route Handlers (no SignalR
  / WebSocket plumbing)

### Negative

- Largest surface area to maintain — 12 panes + shared shell + auth
  + clients = ~10 weeks of engineering for v1 cut
- Need React expertise on the team (vs Microsoft-first C# stack)
- Multi-stage Dockerfile + ACR push adds CI/CD complexity vs
  static-hosting alternatives
- v1 panes are a lot to ship; if running long, Semantic Model
  designer can slip to v1.1 (customer can still author TMDL in Power
  BI Desktop and deploy via Shim's CLI)

### Neutral

- Customers running Loom in GCC-High see the same Console as
  Commercial — only the auth endpoint + container host differ
- Fluent UI v9 chat component pattern for the Copilot sidebar needs
  early validation; streaming + tool-call rendering is the risky bit
- Container image size (~120 MB) is acceptable for both Container
  Apps + AKS cold-start

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Blazor Server + Fluent UI Blazor | Doesn't match Fabric's React aesthetic exactly; Blazor SSR has subtle WebSocket constraints in private-link networks (relevant for federal deploys); smaller React ecosystem for Fluent UI components |
| Power Apps Canvas | Cannot deliver the Fabric look; not extensible enough for parity-service control panes (Activator rule designer, Data Agents config); not a SaaS-product UX |
| Custom HTML + minimal framework | 3-4× longer ship timeline; off the table |
| Vue / Svelte + custom design system | Doesn't match Fabric's React + Fluent stack; loses visual parity advantage |

## References

- PRD: [`temp/fiab-prd/06-custom-apps.md`](../../../temp/fiab-prd/06-custom-apps.md) §6.1
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](../../../temp/fiab-prd/AMENDMENTS.md) §A3
- Parent ADR: [`docs/adr/0014-msal-bff-auth-pattern.md`](../../adr/0014-msal-bff-auth-pattern.md) — Loom inherits this pattern
- External: [Fluent UI v9 docs](https://react.fluentui.dev/), [Next.js 14 App Router](https://nextjs.org/docs)
- Build: PRP-03 — `apps/fiab-console/`
