# CSA Loom Console

The CSA Loom Console is the web application that delivers a Microsoft
Fabric-class analytics experience on **pure Azure-native backends** — no real
Microsoft Fabric capacity, workspace, or Power BI tenant required. It is a
Next.js 15 (App Router) + Fluent UI v9 app with an MSAL BFF auth layer, and it
is the primary UI for the CSA Loom platform (Commercial and Azure Government).

> **Naming**: `fiab-console` is the repo-internal package name
> (`@csa-loom/fiab-console`). The public product name is **CSA Loom** / **Loom
> Console**.

## What the console is today

The console is a working, feature-rich analytics workbench — not a scaffold.
It exposes:

- **~117 item-type editors across 22 categories** (lakehouse, warehouse,
  notebook, KQL database/queryset, eventhouse, eventstream, activator, data
  pipeline, dataflow, mirrored database, semantic model, report, ML model,
  data agent, ontology/graph model, APIs & functions, and more). Every editor
  is mapped from an item-type slug in `lib/catalog/` to a rich editor in
  `lib/editors/` (see `lib/editors/registry.ts` for the full slug→editor map).
  Each item type ships an Azure-native default backend; Fabric/Power BI is
  opt-in only.
- **Unified marketplace** (`/marketplace`) — publish and subscribe to both API
  products and data products, with bidirectional Delta Sharing.
- **Copilots** — a general chat copilot (`/copilot`), per-editor build-assist,
  data-agent config copilot, and a Power BI / report copilot in the report
  designer.
- **Governance** (`/governance`) — Microsoft Purview classic Data Map
  integration, classifications, glossary, lineage, MDM, sensitivity/protection
  policies, scans, and access requests (17 governance surfaces).
- **Report designer** — a Loom-native report authoring surface (pages,
  visuals, DAX, filters, bookmarks, themes, get-data connectors) backed by an
  Azure Analysis Services tabular layer — no Power BI workspace needed.
- **Workspaces + OBO ACL**, a **Learning Hub** (`/learn`), an **MCP server
  catalog** (`/admin/mcp-servers`), **20+ one-click use-case apps** that
  install → provision → seed real Azure backing, a **deploy planner**
  (`/admin/deploy-planner`), and an **admin portal** of ~27 pages
  (`/admin/*`: users, permissions, capacity, scaling, network, tenant
  settings, classifications, usage/chargeback, health, and more).

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) — server + client components |
| UI | Fluent UI v9 (`@fluentui/react-components`) + Loom design tokens |
| Language | TypeScript 5.6, React 19 |
| Auth | MSAL BFF — session cookies, server-side token refresh, OBO for downstream Azure calls |
| Server state | React Query; ephemeral UI state via lightweight stores |
| Data | Azure Cosmos DB (catalog, apps, config), plus per-item Azure data planes (ADLS Gen2 / Synapse SQL / ADX / Event Hubs / Azure Monitor …) |
| Packaging | pnpm workspace; multi-stage Dockerfile; image hosted in ACR |
| Hosting | Azure Container Apps (bicep under `platform/fiab/bicep/`) |
| Testing | Vitest (unit) + Playwright (E2E / UAT), including axe-core accessibility scans (WCAG 2.1 A/AA + Section 508) over the top ~20 surfaces |

## Dev workflow

From the repo root (pnpm workspace):

```bash
pnpm install                      # install workspace deps
pnpm --filter @csa-loom/fiab-console dev     # http://localhost:3000
```

Or from this directory:

```bash
cd apps/fiab-console
pnpm dev        # next dev — http://localhost:3000
pnpm build      # next build (production bundle)
pnpm start      # next start (serve the production build)
pnpm lint       # next lint
pnpm test       # vitest run
```

Container image:

```bash
docker build -t fiab-console .
docker run -p 3000:3000 fiab-console
```

Running the console locally still needs Azure configuration (Entra app
registration + the `LOOM_*` environment variables) to reach live backends;
surfaces that require infrastructure that isn't wired show an honest Fluent
MessageBar naming the exact env var / role / resource to provision, per the
project's no-vaporware rule.

## Accessibility (Section 508 / WCAG 2.1)

The Gov audience requires a Section 508 baseline. `e2e/a11y.uat.ts` runs
[`@axe-core/playwright`](https://www.npmjs.com/package/@axe-core/playwright)
scans (`withTags(['wcag2a','wcag2aa','section508'])`) over the top ~20
load-bearing surfaces — Home, Workspaces, Browse, OneLake, Marketplace,
Governance, Monitor, Real-Time hub, the create-item flow, Admin overview,
Setup, Copilot, the lakehouse / report / notebook / KQL-dashboard editors,
semantic model, data products, connections, and deployment pipelines. The gate
fails on any `critical`- or `serious`-impact violation (`moderate` / `minor` are
logged, not blocking); third-party embeds we don't author (`iframe`,
`.monaco-editor`) are excluded so the scan audits Loom's own markup.

```bash
SESSION_SECRET=<from-KV> pnpm test:a11y      # playwright test --grep @a11y
```

The suite is discovered by the in-VNet `loom-uat` runner (it globs `*.uat.ts`),
so the scans also run on every roll as part of the release-validation gate.

## Deploying the platform

The console is deployed as part of the full CSA Loom platform. The canonical,
end-to-end install path (clone → working Console URL in ~60 minutes) is
documented in the deployment quickstart — follow it rather than deploying the
console image in isolation:

- **[Deployment quickstart](../../docs/fiab/deployment/quickstart.md)** — the
  supported happy path (Commercial). Gov boundaries: see
  [GCC](../../docs/fiab/deployment/gcc.md) /
  [GCC-High](../../docs/fiab/deployment/gcc-high.md).
- IaC lives under [`platform/fiab/bicep/`](../../platform/fiab/bicep/); the
  full topology deploys from `platform/fiab/bicep/main.bicep` with the
  `params/commercial-full.bicepparam` parameter set.

## Related docs

- [Loom Console docs](../../docs/fiab/console/index.md) — setup wizard,
  copilot runtime, connections, MCP tool server
- [Deployment guides](../../docs/fiab/deployment/index.md)
- [Architecture](../../docs/fiab/architecture.md)
- Published docs site: <https://fgarofalo56.github.io/csa-inabox/>
