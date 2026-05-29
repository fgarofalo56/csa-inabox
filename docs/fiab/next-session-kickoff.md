# Fabric UI rebuild - fresh session kickoff

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


See `docs/fiab/console-v2-ui-handoff.md` for the full state-of-the-world the prompt below references.

## Prompt (paste into a fresh session)

You are taking over the CSA Loom Console UI rebuild. Previous session validated infra end-to-end and shipped 8 stub panes. Your job: rebuild the Console to match Microsoft Fabric in full - every workload, every item type, real editors, admin center, login flow. Target: "better than Fabric."

Read first: `docs/fiab/console-v2-ui-handoff.md` on branch `access-patterns-vpn-agw-fd`. Live URLs, resource IDs, what already works (don't rebuild), what's missing, tooling gotchas, deploy + UAT loop.

Research phase (before any code): use `microsoft_docs_search` + `microsoft_docs_fetch` from Microsoft Learn MCP. Build authoritative inventory of every Fabric workload, item type, cross-cutting surface (OneLake catalog, Monitor hub, Real-Time hub, Workload hub, Admin portal, Deployment pipelines, Git integration), and item-editor anatomy. Fetch the Extensibility Toolkit concept-item-overview page, Fabric overview, item-definition-overview REST API page, every workload landing page. Pull Power BI, Power Query, Dataflow Gen2, Data Pipeline (user called these out). Write to `docs/fiab/fabric-feature-inventory.md`. Commit. Reference in every subsequent commit.

### Build phases (ship each before starting next; do not queue unverified work)

Phase 1 - Foundation. Workspaces as root nav primitive (Fabric organizes around workspaces). `+ New item` dialog showing every item type categorized by workload. Admin portal with stubbed tenant / capacity / security / audit / usage pages. MSAL sign-in / sign-out wired end-to-end (replace mock at `apps/fiab-console/lib/auth/session.ts`; create Entra app reg via `az ad app create` if needed; bind redirect URIs to both public hostnames + localhost). Reusable Ribbon + EmptyState components.

Phase 2 - Data Engineering + Data Factory (the ETL/ELT). Lakehouse editor (Files / Tables / Shortcuts), Notebook editor (Monaco cells + kernel + language selectors + real cell + output model), Spark job definition, Environment. Data pipeline editor (React Flow canvas; Copy / Lookup / If / ForEach / Wait / Web / Notebook / Stored Procedure / Dataflow). Dataflow Gen2 editor (Power Query Online UX with visual + M code tabs). Copy job. Mirrored database (connector wizard: SQL Server / Postgres / Cosmos / Snowflake / Databricks). dbt job.

Phase 3 - Real-Time + Data Warehouse + Power BI. Eventhouse / KQL database / KQL queryset / KQL dashboard (Monaco with KQL). Eventstream (canvas). Activator (rule builder + action library + history). Warehouse (Monaco T-SQL + tables + permissions). Semantic model (tables + relationships + measures + roles). Report (shell + iframe placeholder). Dashboard / Paginated report / Scorecard (shells).

Phase 4 - Data Science + APIs + Fabric IQ + Industry. ML model + ML experiment. GraphQL API. User data function. Variable library. Fabric IQ shells (Graph / Ontology / Plan / Maps). Industry hub.

Phase 5 - Cross-cutting. OneLake catalog (browseable tree + search + lineage + sensitivity labels). Monitor hub (per-item run history). Real-Time hub (event source catalog + subscriptions). Workload hub (My + More workloads tabs). Deployment pipelines (dev/test/prod + promote button). Git integration. Per-item sharing + permissions + sensitivity labels.

Phase 6 - Polish (better than Fabric). Copilot side-pane in every editor. Command palette (Ctrl+K). Multi-tab open items (VS Code style). Saved views / pinned items. Cross-item search. Better empty states than Fabric (defaults are bare; add inline tutorials + create-from-sample buttons).

### Constraints

- Fluent UI v9 for primitives, Monaco for code editors, React Flow for canvas. No Bootstrap / Tailwind / MUI.
- Next.js 15 App Router.
- Every page needs an h1 (prior e2e found h1 missing across all panes).
- Every interactive surface needs Playwright coverage. Extend `apps/fiab-console/tests/uat-fd.mjs`.
- Build incrementally. Ship each phase. Verify GREEN. Then start next.

### Tooling gotchas

1. `Write` tool intermittently fails on large content (~3KB+) with "required parameter file_path is missing". Workaround: small files + multiple `Edit` calls.
2. Bash heredocs truncate on Windows MSYS for same reason.
3. GHA Docker layer cache reuses old layers. Bump `apps/fiab-console/.build-marker` each iteration.
4. Bicep redeploys flip Console ingress to internal. Re-flip via `az containerapp ingress update --type external`.
5. `/api/health` route exists - do not remove (ACA probes target it).
6. Front Door PE approval not auto. Manual `az rest PUT` on ACA env's `privateEndpointConnections` if FD rebuilt.

### Definition of done

- Every Fabric item type in the inventory has a route, an editor shell with realistic Fluent UI structure, and a stub BFF route returning sensible data.
- Admin portal exists with stubbed tenant / capacity / security / audit / usage pages.
- MSAL sign-in works end-to-end (login, session persists, sign-out clears it).
- OneLake catalog, Monitor hub, Real-Time hub, Workload hub, Deployment pipelines, Git integration all exist as navigable pages.
- Playwright e2e covers every new page (8/8 today should grow to 40+/40+ all GREEN).
- A first-time user can click through an end-to-end scenario: sign in, browse workspaces, create a Lakehouse, open it, see the empty Files / Tables / Shortcuts panes, click the Open in Notebook ribbon button, land in the Notebook editor with a starter cell.
